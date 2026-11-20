'use strict';

/* =========================================================
 * Escala Mensal
 * - Funções (colunas da escala)
 * - Datas/turnos (linhas da escala)
 * - Pessoas: funções que exercem + datas em que NÃO podem
 * - Geração aleatória balanceada respeitando indisponibilidades
 * ========================================================= */

const CHAVE_STORAGE = 'escala-mensal:v1';
const TURNOS = ['', 'manhã', 'tarde', 'noite'];
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
  'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const TENTATIVAS_GERACAO = 300;
const SEM_PESSOA = '';

/* ---------------- Estado ---------------- */

function estadoInicial() {
  const hoje = new Date();
  return {
    mes: `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`,
    funcoes: ['Som', 'Telão', 'Transmissão'],
    cultos: [],          // { data: 'AAAA-MM-DD', turno: '' | 'manhã' | 'tarde' | 'noite' }
    pessoas: [],         // { id, nome, funcoes: [..], indisponiveis: ['AAAA-MM-DD|turno'], podeRepetir }
    escalas: {},         // { 'AAAA-MM': { 'AAAA-MM-DD|turno': { funcao: [nomes] } } }
    pares: [],           // { id, a: idPessoa, b: idPessoa } — preferem servir no mesmo dia
    funcoesNaoAcumulaveis: [], // funções que nunca podem ser somadas a outra pela mesma pessoa
  };
}

let estado = carregar();

function carregar() {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE_STORAGE));
    if (salvo) return { ...estadoInicial(), ...salvo };
  } catch { /* storage indisponível: começa vazio */ }
  return estadoInicial();
}

function salvar() {
  try { localStorage.setItem(CHAVE_STORAGE, JSON.stringify(estado)); } catch { /* ignora */ }
}

/* ---------------- Utilidades ---------------- */

const $ = (sel) => document.querySelector(sel);

function chaveCulto(culto) {
  return `${culto.data}|${culto.turno}`;
}

function paraData(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d);
}

function paraIso(data) {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

function rotuloCulto(culto) {
  const data = paraData(culto.data);
  const dia = String(data.getDate()).padStart(2, '0');
  const semana = data.toLocaleDateString('pt-BR', { weekday: 'long' });
  return `${dia} - ${semana}${culto.turno ? ` (${culto.turno})` : ''}`;
}

function rotuloCurto(culto) {
  const data = paraData(culto.data);
  const semana = data.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return `${String(data.getDate()).padStart(2, '0')} ${semana}${culto.turno ? ` ${culto.turno}` : ''}`;
}

function tituloMes() {
  const [ano, mes] = estado.mes.split('-').map(Number);
  return `Escala ${MESES[mes - 1]}/${ano}`;
}

function ordenarCultos(a, b) {
  return a.data.localeCompare(b.data) || TURNOS.indexOf(a.turno) - TURNOS.indexOf(b.turno);
}

function cultosDoMes() {
  return estado.cultos.filter((c) => c.data.startsWith(estado.mes)).sort(ordenarCultos);
}

function escalaDoMes() {
  return estado.escalas[estado.mes] || {};
}

function embaralhar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function rotuloTurno(turno) {
  return turno ? turno[0].toUpperCase() + turno.slice(1) : 'Turno único';
}

function preencherTurnos(select) {
  select.innerHTML = TURNOS.map((t) => `<option value="${t}">${rotuloTurno(t)}</option>`).join('');
}

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- Geração da escala ---------------- */

/** Quantas pessoas a função precisa na data (padrão 1; 0 = função não usada no dia). */
function vagasDe(culto, funcao) {
  const n = culto.vagas?.[funcao];
  return Number.isInteger(n) ? n : 1;
}

/** Nomes escalados numa célula; aceita o formato antigo (string) e o novo (lista). */
function nomesDaCelula(linha, funcao) {
  const valor = linha?.[funcao];
  if (Array.isArray(valor)) return valor;
  return valor ? [valor] : [];
}

function podeServir(pessoa, funcao, culto) {
  const temFuncao = pessoa.funcoes.length === 0 || pessoa.funcoes.includes(funcao);
  return temFuncao && !pessoa.indisponiveis.includes(chaveCulto(culto));
}

/**
 * Gera uma tentativa de escala. Para cada vaga escolhe, entre as pessoas
 * disponíveis, a que tem menos escalas no mês (desempate aleatório),
 * penalizando quem serviu na data imediatamente anterior.
 * Acúmulo de funções: uma pessoa só assume uma segunda função na mesma
 * data/turno se (1) a data permite acúmulo, (2) a pessoa tem "podeRepetir" e
 * (3) todas as funções envolvidas são acumuláveis. Mesmo assim, só é
 * preferida para isso quando ninguém mais está livre.
 * Pares: quem tem o par já escalado no dia ganha um bônus (preferência,
 * não obrigação), e as tentativas que separam menos pares vencem o desempate.
 */
const BONUS_PAR = 8; // menor que 10 (uma escala a mais), para não desequilibrar a divisão

function funcaoAcumulavel(funcao) {
  return !estado.funcoesNaoAcumulaveis.includes(funcao);
}

/** A pessoa pode somar todas essas funções na mesma data/turno? */
function podeAcumular(pessoa, culto, funcoes) {
  return culto.acumular === true && pessoa.podeRepetir === true && funcoes.every(funcaoAcumulavel);
}

function parceirosPorPessoa() {
  const mapa = new Map(estado.pessoas.map((p) => [p.id, new Set()]));
  for (const { a, b } of estado.pares) {
    mapa.get(a)?.add(b);
    mapa.get(b)?.add(a);
  }
  return mapa;
}

/** Par separado = só um dos dois serve na data, embora o outro estivesse disponível. */
function contarSeparacoes(culto, usadosNoCulto) {
  const disponivel = (id) => !pessoaPorId(id)?.indisponiveis.includes(chaveCulto(culto));
  return estado.pares.filter(({ a, b }) =>
    (usadosNoCulto.has(a) && !usadosNoCulto.has(b) && disponivel(b))
    || (usadosNoCulto.has(b) && !usadosNoCulto.has(a) && disponivel(a))).length;
}

function gerarTentativa(cultos) {
  const escala = {};
  const total = Object.fromEntries(estado.pessoas.map((p) => [p.id, 0]));
  const parceiros = parceirosPorPessoa();
  let vagasVazias = 0;
  let separacoes = 0;
  let anteriores = new Set();

  for (const culto of cultos) {
    const chave = chaveCulto(culto);
    const usadosNoCulto = new Set();
    const funcoesNoCulto = new Map(); // id da pessoa -> funções que já assumiu nesta data
    escala[chave] = {};

    for (const funcao of embaralhar(estado.funcoes)) {
      const nomes = [];
      const usadosNaFuncao = new Set();

      for (let vaga = 0; vaga < vagasDe(culto, funcao); vaga++) {
        // a mesma pessoa nunca ocupa duas vagas da mesma função no mesmo dia
        const candidatos = estado.pessoas.filter((p) => podeServir(p, funcao, culto)
          && !usadosNaFuncao.has(p.id)
          && (!usadosNoCulto.has(p.id) || podeAcumular(p, culto, [...funcoesNoCulto.get(p.id), funcao])));

        if (candidatos.length === 0) {
          nomes.push(SEM_PESSOA);
          vagasVazias++;
          continue;
        }

        const pontuar = (p) => total[p.id] * 10
          + (anteriores.has(p.id) ? 5 : 0)
          + (usadosNoCulto.has(p.id) ? 20 : 0)
          - ([...parceiros.get(p.id)].some((id) => usadosNoCulto.has(id)) ? BONUS_PAR : 0)
          + Math.random();
        const escolhido = candidatos
          .map((p) => ({ p, pontos: pontuar(p) }))
          .reduce((melhor, atual) => (atual.pontos < melhor.pontos ? atual : melhor)).p;

        nomes.push(escolhido.nome);
        usadosNaFuncao.add(escolhido.id);
        usadosNoCulto.add(escolhido.id);
        funcoesNoCulto.set(escolhido.id, [...(funcoesNoCulto.get(escolhido.id) || []), funcao]);
        total[escolhido.id]++;
      }
      escala[chave][funcao] = nomes;
    }
    separacoes += contarSeparacoes(culto, usadosNoCulto);
    anteriores = usadosNoCulto;
  }

  const contagens = Object.values(total);
  const desequilibrio = contagens.length ? Math.max(...contagens) - Math.min(...contagens) : 0;
  return { escala, vagasVazias, desequilibrio, separacoes };
}

function gerarEscala() {
  const cultos = cultosDoMes();
  if (!estado.funcoes.length) return mostrarAviso('Cadastre ao menos uma função.');
  if (!cultos.length) return mostrarAviso('Adicione ao menos uma data neste mês.');
  if (!estado.pessoas.length) return mostrarAviso('Cadastre ao menos uma pessoa.');

  let melhor = null;
  for (let i = 0; i < TENTATIVAS_GERACAO; i++) {
    const tentativa = gerarTentativa(cultos);
    // prioridade: menos vagas vazias > divisão mais equilibrada > menos pares separados
    const comparar = (x, y) => x.vagasVazias - y.vagasVazias
      || x.desequilibrio - y.desequilibrio
      || x.separacoes - y.separacoes;
    if (!melhor || comparar(tentativa, melhor) < 0) melhor = tentativa;
  }

  estado.escalas[estado.mes] = melhor.escala;
  salvar();
  renderizarEscala();
}

/* ---------------- Renderização ---------------- */

function mostrarAviso(texto) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.hidden = !texto;
}

function icone(id) {
  return `<svg><use href="#i-${id}"/></svg>`;
}

/** Matiz (0–359) estável por nome, usado para colorir avatar e pílulas. */
function matiz(nome) {
  let h = 0;
  for (const ch of nome) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function iniciais(nome) {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] || '') + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

function avatar(nome) {
  return `<span class="avatar" style="--h:${matiz(nome)}">${escapar(iniciais(nome))}</span>`;
}

function blocoData(culto) {
  const data = paraData(culto.data);
  const semana = data.toLocaleDateString('pt-BR', { weekday: 'long' });
  return `<span class="dia-num dia-${data.getDay()}">${String(data.getDate()).padStart(2, '0')}</span>
    <span class="dia-info"><span class="dia-sem">${escapar(semana)}</span>
    <span class="turno-tag">${escapar(culto.turno || 'turno único')}</span></span>`;
}

let temporizadorToast;
function toast(texto) {
  const el = $('#toast');
  el.textContent = texto;
  el.classList.add('visivel');
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => el.classList.remove('visivel'), 2200);
}

/** Lista com exatamente vagasDe(culto, f) posições ('' = vaga em aberto). */
function vagasPreenchidas(culto, funcao) {
  const nomes = nomesDaCelula(escalaDoMes()[chaveCulto(culto)], funcao);
  return Array.from({ length: vagasDe(culto, funcao) }, (_, i) => nomes[i] || SEM_PESSOA);
}

function contarVagas() {
  let total = 0;
  let preenchidas = 0;
  for (const c of cultosDoMes()) {
    for (const f of estado.funcoes) {
      const vagas = vagasPreenchidas(c, f);
      total += vagas.length;
      preenchidas += vagas.filter(Boolean).length;
    }
  }
  return { total, preenchidas };
}

/** Resumo das vagas que fogem do padrão (1 por função), ex.: "Som 2 · Telão 0". */
function resumoVagas(culto) {
  return [
    ...estado.funcoes.filter((f) => vagasDe(culto, f) !== 1).map((f) => `${f} ${vagasDe(culto, f)}`),
    ...(culto.acumular ? ['Acumula funções'] : []),
  ].join(' · ');
}

function renderizarEstatisticas() {
  const { total, preenchidas } = contarVagas();
  const gerada = Object.keys(escalaDoMes()).length > 0;
  const faltam = total - preenchidas;
  const tiles = [
    { ic: 'calendario', valor: cultosDoMes().length, rotulo: 'Datas no mês' },
    { ic: 'pessoas', valor: estado.pessoas.length, rotulo: 'Pessoas' },
    { ic: 'funcao', valor: estado.funcoes.length, rotulo: 'Funções' },
    gerada
      ? { ic: faltam ? 'alerta' : 'dado', valor: `${preenchidas}/${total}`, rotulo: faltam ? `${faltam} vaga(s) em aberto` : 'Vagas preenchidas', alerta: faltam > 0 }
      : { ic: 'dado', valor: total, rotulo: 'Vagas a preencher' },
  ];
  $('#estatisticas').innerHTML = tiles.map((t) => `
    <div class="estat ${t.alerta ? 'alerta' : ''}">
      <span class="icone">${icone(t.ic)}</span>
      <div><strong>${t.valor}</strong><span>${escapar(t.rotulo)}</span></div>
    </div>`).join('');
}

function renderizarFuncoes() {
  $('#listaFuncoes').innerHTML = estado.funcoes.map((f, i) => {
    const acumulavel = funcaoAcumulavel(f);
    return `
    <li class="${acumulavel ? '' : 'nao-acumula'}">${escapar(f)}
      <button class="acumular-toggle" data-acumular-funcao="${escapar(f)}" aria-pressed="${acumulavel}"
        title="${acumulavel
          ? 'Pode ser acumulada com outra função (clique para bloquear)'
          : 'Não pode ser acumulada com outra função (clique para liberar)'}">${icone(acumulavel ? 'link' : 'bloqueio')}</button>
      <button class="remover" data-remover-funcao="${i}" title="Remover ${escapar(f)}">${icone('x')}</button></li>`;
  }).join('') || '<li class="vazio">Nenhuma função cadastrada</li>';
}

function renderizarCultos() {
  const cultos = cultosDoMes();
  $('#listaCultos').innerHTML = cultos.map((c) => {
    const resumo = resumoVagas(c);
    return `
    <li class="item-data">
      <button class="item-data-corpo" data-vagas="${escapar(chaveCulto(c))}" title="Definir quantas pessoas cada função precisa">
        ${blocoData(c)}
        ${resumo ? `<span class="vagas-tag">${escapar(resumo)}</span>` : ''}
      </button>
      <span class="item-data-acoes">
        <button class="remover" data-vagas="${escapar(chaveCulto(c))}" title="Pessoas por função">${icone('pessoas')}</button>
        <button class="remover" data-remover-culto="${escapar(chaveCulto(c))}" title="Remover">${icone('x')}</button>
      </span></li>`;
  }).join('') || '<li class="vazio" style="grid-column:1/-1">Nenhuma data neste mês</li>';
  $('#limparCultos').hidden = cultos.length === 0;
}

function renderizarPessoas() {
  const cultos = cultosDoMes();
  $('#listaPessoas').innerHTML = estado.pessoas.map((p) => {
    const indisp = cultos.filter((c) => p.indisponiveis.includes(chaveCulto(c))).length;
    const funcoesTxt = p.funcoes.length ? p.funcoes.join(', ') : 'Todas as funções';
    return `
    <div class="pessoa">
      <div class="pessoa-topo">
        ${avatar(p.nome)}
        <div class="pessoa-nome">
          <strong title="${escapar(p.nome)}">${escapar(p.nome)}</strong>
          <small>${escapar(funcoesTxt)}${indisp ? ` · não pode em ${indisp} data(s)` : ''}</small>
          ${parceirosDe(p.id).length ? `<small class="par-tag">${icone('link')}${escapar(parceirosDe(p.id).join(', '))}</small>` : ''}
        </div>
        <button class="remover" data-remover-pessoa="${p.id}" title="Remover pessoa">${icone('lixo')}</button>
      </div>
      <div>
        <div class="rotulo">Funções</div>
        <div class="funcoes-pessoa">
          ${estado.funcoes.map((f) => `
            <label class="pill-toggle">
              <input type="checkbox" data-pessoa="${p.id}" data-funcao="${escapar(f)}" ${p.funcoes.includes(f) ? 'checked' : ''}>
              <span>${escapar(f)}</span>
            </label>`).join('')}
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" data-repetir="${p.id}" ${p.podeRepetir ? 'checked' : ''}>
        <span class="trilho"></span>
        <span>Pode cumprir mais de uma função no mesmo dia
          <small class="dica-switch">só nas datas que permitem acúmulo</small></span>
      </label>
      <div>
        <div class="rotulo">Não pode em</div>
        <div class="datas-pessoa">
          ${cultos.map((c) => {
            const chave = chaveCulto(c);
            const data = paraData(c.data);
            const semana = data.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
            const marcado = p.indisponiveis.includes(chave);
            return `<button class="data-chip ${marcado ? 'indisponivel' : ''}" aria-pressed="${marcado}"
              data-pessoa="${p.id}" data-indisponivel="${escapar(chave)}" title="${escapar(rotuloCulto(c))}">
              <b>${String(data.getDate()).padStart(2, '0')}</b><small>${escapar(c.turno || semana)}</small></button>`;
          }).join('') || '<span class="vazio" style="grid-column:1/-1">Adicione datas ao mês</span>'}
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="vazio">Nenhuma pessoa cadastrada ainda. Adicione a primeira acima.</p>';
}

/** Nomes das pessoas que formam par com a pessoa informada. */
function parceirosDe(id) {
  return estado.pares
    .filter((par) => par.a === id || par.b === id)
    .map((par) => pessoaPorId(par.a === id ? par.b : par.a)?.nome)
    .filter(Boolean);
}

function renderizarPares() {
  const pessoas = [...estado.pessoas].sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
  for (const sel of [$('#parA'), $('#parB')]) {
    const atual = sel.value;
    sel.innerHTML = '<option value="">Escolha…</option>'
      + pessoas.map((p) => `<option value="${p.id}">${escapar(p.nome)}</option>`).join('');
    sel.value = pessoas.some((p) => p.id === atual) ? atual : '';
  }
  $('#formPar').hidden = estado.pessoas.length < 2;

  $('#listaPares').innerHTML = estado.pares.map((par) => {
    const a = pessoaPorId(par.a);
    const b = pessoaPorId(par.b);
    if (!a || !b) return '';
    return `<li class="item-par">
      <span class="par-pessoa">${avatar(a.nome)}<span>${escapar(a.nome)}</span></span>
      <span class="par-elo">${icone('link')}</span>
      <span class="par-pessoa">${avatar(b.nome)}<span>${escapar(b.nome)}</span></span>
      <button class="remover" data-remover-par="${par.id}" title="Desfazer par">${icone('x')}</button>
    </li>`;
  }).join('') || `<li class="vazio">${estado.pessoas.length < 2
    ? 'Cadastre ao menos duas pessoas para formar pares'
    : 'Nenhum par. Escolha duas pessoas acima.'}</li>`;
}

function renderizarEscala() {
  mostrarAviso('');
  const cultos = cultosDoMes();
  const escala = escalaDoMes();
  const tabela = $('#tabelaEscala');

  if (!Object.keys(escala).length) {
    tabela.innerHTML = `<tbody><tr><td class="escala-vazia-td" style="border:none">
      <div class="escala-vazia">${icone('dado')}<strong>Nenhuma escala gerada para este mês</strong>
      <span>Cadastre funções, datas e pessoas e clique em "Gerar escala".</span></div></td></tr></tbody>`;
    $('#resumo').innerHTML = '';
    renderizarEstatisticas();
    return;
  }

  const nomes = estado.pessoas.map((p) => p.nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  let vazias = 0;

  const linhas = cultos.map((c) => {
    const chave = chaveCulto(c);
    const celulas = estado.funcoes.map((f) => {
      const vagas = vagasPreenchidas(c, f);
      if (!vagas.length) return '<td class="nao-precisa" title="Função não necessária nesta data">—</td>';

      const selects = vagas.map((atual, indice) => {
        if (!atual) vazias++;
        const opcoes = [`<option value="">— vaga em aberto —</option>`, ...nomes.map((n) =>
          `<option ${n === atual ? 'selected' : ''}>${escapar(n)}</option>`)];
        if (atual && !nomes.includes(atual)) opcoes.push(`<option selected>${escapar(atual)}</option>`);
        return `<select class="${atual ? '' : 'faltando'}" data-celula="${escapar(chave)}" data-funcao="${escapar(f)}"
          data-indice="${indice}" aria-label="${escapar(f)} ${indice + 1} em ${escapar(rotuloCulto(c))}"
          ${atual ? `style="--h:${matiz(atual)}"` : ''}>${opcoes.join('')}</select>`;
      }).join('');
      return `<td><div class="vagas-celula">${selects}</div></td>`;
    }).join('');
    return `<tr><th scope="row"><div class="data-cel">${blocoData(c)}
      <button class="remover editar-vagas" data-vagas="${escapar(chave)}" title="Pessoas por função">${icone('pessoas')}</button>
      </div></th>${celulas}</tr>`;
  }).join('');

  tabela.innerHTML = `
    <thead><tr><th>${escapar(tituloMes())}</th>${estado.funcoes.map((f) => `<th>${escapar(f)}</th>`).join('')}</tr></thead>
    <tbody>${linhas}</tbody>`;

  if (vazias) {
    mostrarAviso(`${vazias} vaga(s) sem pessoa disponível. Ajuste as indisponibilidades, permita acúmulo de funções na data ou escolha manualmente.`);
  }
  renderizarResumo(cultos, escala);
  renderizarEstatisticas();
}

function renderizarResumo(cultos, escala) {
  const contagem = Object.fromEntries(estado.pessoas.map((p) => [p.nome, 0]));
  for (const c of cultos) {
    for (const f of estado.funcoes) {
      for (const nome of vagasPreenchidas(c, f)) {
        if (nome) contagem[nome] = (contagem[nome] || 0) + 1;
      }
    }
  }
  const itens = Object.entries(contagem).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
  const maximo = Math.max(1, ...itens.map(([, n]) => n));
  $('#resumo').innerHTML = `<h3>Distribuição no mês</h3><div class="barras">${itens.map(([nome, n]) => `
    <div class="barra" style="--h:${matiz(nome)}">
      ${avatar(nome)}<span class="nome" title="${escapar(nome)}">${escapar(nome)}</span>
      <span class="trilho"><i style="width:${(n / maximo) * 100}%"></i></span><b>${n}</b>
    </div>`).join('')}</div>${resumoPares(cultos)}`;
}

/** Quantas datas cada par serviu junto e quantas serviu separado. */
function resumoPares(cultos) {
  const linhas = estado.pares.map((par) => {
    const a = pessoaPorId(par.a);
    const b = pessoaPorId(par.b);
    if (!a || !b) return '';
    let juntos = 0;
    let separados = 0;
    for (const c of cultos) {
      const nomes = new Set(estado.funcoes.flatMap((f) => vagasPreenchidas(c, f)));
      const temA = nomes.has(a.nome);
      const temB = nomes.has(b.nome);
      if (temA && temB) juntos++;
      else if (temA || temB) separados++;
    }
    return `<div class="par-resumo">
      <span class="par-nomes">${escapar(a.nome)} ${icone('link')} ${escapar(b.nome)}</span>
      <span class="selo ok">${juntos} junto(s)</span>
      ${separados ? `<span class="selo aviso-selo" title="Datas em que só um dos dois serviu">${separados} separado(s)</span>` : ''}
    </div>`;
  }).join('');
  return linhas ? `<h3 class="sub">Pares</h3><div class="pares-resumo">${linhas}</div>` : '';
}

function renderizarTudo() {
  $('#mesSelecionado').value = estado.mes;
  $('#mesNome').textContent = tituloMes().replace('Escala ', '').replace('/', ' ');
  renderizarFuncoes();
  renderizarCultos();
  renderizarPessoas();
  renderizarPares();
  renderizarEscala();
}

/* ---------------- Exportação ---------------- */

function matrizEscala() {
  const cabecalho = [tituloMes(), ...estado.funcoes];
  const linhas = cultosDoMes().map((c) => [
    rotuloCulto(c),
    ...estado.funcoes.map((f) => {
      const vagas = vagasPreenchidas(c, f);
      return vagas.length ? vagas.map((n) => n || '—').join(' / ') : '-';
    }),
  ]);
  return [cabecalho, ...linhas];
}

async function copiarTabela() {
  if (!Object.keys(escalaDoMes()).length) return toast('Gere a escala antes de copiar.');
  const texto = matrizEscala().map((l) => l.join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(texto);
    toast('Tabela copiada! Cole no Excel, Planilhas ou WhatsApp.');
  } catch {
    toast('Não foi possível copiar automaticamente.');
  }
}

function baixarCsv() {
  if (!Object.keys(escalaDoMes()).length) return toast('Gere a escala antes de baixar.');
  const csv = matrizEscala()
    .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `escala-${estado.mes}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------------- Backup (importar / exportar) ---------------- */

const VERSAO_ARQUIVO = 1;

function exportarDados() {
  const conteudo = {
    app: 'escala-mensal',
    versao: VERSAO_ARQUIVO,
    exportadoEm: new Date().toISOString(),
    dados: estado,
  };
  const blob = new Blob([JSON.stringify(conteudo, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `escala-mensal-backup-${paraIso(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Arquivo de backup gerado.');
}

const ehTexto = (v) => typeof v === 'string';
const ehData = (v) => ehTexto(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Valida e normaliza os dados lidos de um arquivo; lança erro se o formato não servir. */
function validarDados(bruto) {
  const dados = bruto?.app === 'escala-mensal' ? bruto.dados : bruto;
  if (!dados || typeof dados !== 'object'
    || !Array.isArray(dados.funcoes) || !Array.isArray(dados.cultos) || !Array.isArray(dados.pessoas)) {
    throw new Error('O arquivo não parece ser um backup da Escala Mensal.');
  }

  const funcoes = [...new Set(dados.funcoes.filter(ehTexto).map((f) => f.trim()).filter(Boolean))];

  const cultos = dados.cultos
    .filter((c) => c && ehData(c.data))
    .map((c) => {
      const culto = { data: c.data, turno: TURNOS.includes(c.turno) ? c.turno : '' };
      if (c.acumular === true) culto.acumular = true;
      if (c.vagas && typeof c.vagas === 'object') {
        const vagas = Object.fromEntries(Object.entries(c.vagas)
          .filter(([f, n]) => funcoes.includes(f) && Number.isInteger(n) && n >= 0 && n <= 20));
        if (Object.keys(vagas).length) culto.vagas = vagas;
      }
      return culto;
    });

  const pessoas = dados.pessoas
    .filter((p) => p && ehTexto(p.nome) && p.nome.trim())
    .map((p) => ({
      id: ehTexto(p.id) && p.id ? p.id : crypto.randomUUID(),
      nome: p.nome.trim(),
      funcoes: Array.isArray(p.funcoes) ? p.funcoes.filter((f) => funcoes.includes(f)) : [],
      indisponiveis: Array.isArray(p.indisponiveis) ? p.indisponiveis.filter(ehTexto) : [],
      podeRepetir: p.podeRepetir === true,
    }));

  const escalas = dados.escalas && typeof dados.escalas === 'object' && !Array.isArray(dados.escalas)
    ? dados.escalas : {};

  const ids = new Set(pessoas.map((p) => p.id));
  const pares = (Array.isArray(dados.pares) ? dados.pares : [])
    .filter((par) => par && ids.has(par.a) && ids.has(par.b) && par.a !== par.b)
    .map((par) => ({ id: ehTexto(par.id) && par.id ? par.id : crypto.randomUUID(), a: par.a, b: par.b }));

  return {
    ...estadoInicial(),
    mes: /^\d{4}-\d{2}$/.test(dados.mes) ? dados.mes : estado.mes,
    funcoes,
    cultos,
    pessoas,
    escalas,
    pares,
    funcoesNaoAcumulaveis: Array.isArray(dados.funcoesNaoAcumulaveis)
      ? dados.funcoesNaoAcumulaveis.filter((f) => funcoes.includes(f)) : [],
  };
}

async function importarDados(arquivo) {
  if (!arquivo) return;
  try {
    const novo = validarDados(JSON.parse(await arquivo.text()));
    const resumo = `${novo.pessoas.length} pessoa(s), ${novo.pares.length} par(es), ${novo.funcoes.length} função(ões), `
      + `${novo.cultos.length} data(s) e ${Object.keys(novo.escalas).length} escala(s) gerada(s)`;
    if (!confirm(`Importar "${arquivo.name}"?\n\nO arquivo contém ${resumo}.\n\n`
      + 'As informações atuais serão substituídas. Se quiser guardá-las, cancele e clique em "Exportar" antes.')) return;
    estado = novo;
    atualizar();
    toast('Informações importadas com sucesso.');
  } catch (erro) {
    toast(erro instanceof SyntaxError ? 'Arquivo inválido: não é um JSON.' : erro.message);
  }
}

/* ---------------- Ações ---------------- */

function adicionarCulto(data, turno) {
  const existe = estado.cultos.some((c) => c.data === data && c.turno === turno);
  if (!existe) estado.cultos.push({ data, turno });
}

function adicionarRecorrentes() {
  const dias = [...document.querySelectorAll('#diasSemana input:checked')].map((i) => Number(i.value));
  if (!dias.length) return toast('Selecione ao menos um dia da semana.');
  const turno = $('#turnoRecorrente').value;
  const [ano, mes] = estado.mes.split('-').map(Number);
  const antes = estado.cultos.length;
  for (let d = new Date(ano, mes - 1, 1); d.getMonth() === mes - 1; d.setDate(d.getDate() + 1)) {
    if (dias.includes(d.getDay())) adicionarCulto(paraIso(d), turno);
  }
  toast(`${estado.cultos.length - antes} data(s) adicionada(s).`);
  atualizar();
}

/* ---- Pessoas por função em uma data ---- */

let cultoEmEdicao = null;

function abrirVagas(chave) {
  const culto = estado.cultos.find((c) => chaveCulto(c) === chave);
  if (!culto) return;
  if (!estado.funcoes.length) return toast('Cadastre ao menos uma função.');
  cultoEmEdicao = culto;

  const semana = paraData(culto.data).toLocaleDateString('pt-BR', { weekday: 'long' });
  $('#vagasTitulo').textContent = rotuloCulto(culto);
  $('#vagasAplicarTexto').textContent =
    `Aplicar a todas as datas de ${semana}${culto.turno ? ` (${culto.turno})` : ''} do mês`;
  $('#vagasAplicarSemana').checked = false;
  $('#vagasAcumular').checked = culto.acumular === true;
  preencherCamposVagas((f) => vagasDe(culto, f));
  $('#dialogVagas').returnValue = '';
  $('#dialogVagas').showModal();
}

function preencherCamposVagas(valorDe) {
  $('#vagasCampos').innerHTML = estado.funcoes.map((f) => `
    <div class="vaga-linha">
      <span>${escapar(f)}</span>
      <div class="stepper">
        <button type="button" data-passo="-1" aria-label="Menos">−</button>
        <input type="number" min="0" max="20" value="${valorDe(f)}" data-vaga-funcao="${escapar(f)}" aria-label="Pessoas em ${escapar(f)}">
        <button type="button" data-passo="1" aria-label="Mais">+</button>
      </div>
    </div>`).join('');
}

function salvarVagas() {
  const culto = cultoEmEdicao;
  if (!culto) return;
  const vagas = {};
  document.querySelectorAll('#vagasCampos input[data-vaga-funcao]').forEach((input) => {
    const n = Math.max(0, Math.min(20, Math.round(Number(input.value) || 0)));
    if (n !== 1) vagas[input.dataset.vagaFuncao] = n;
  });

  const diaSemana = paraData(culto.data).getDay();
  const alvos = $('#vagasAplicarSemana').checked
    ? cultosDoMes().filter((c) => c.turno === culto.turno && paraData(c.data).getDay() === diaSemana)
    : [culto];
  const acumular = $('#vagasAcumular').checked;
  alvos.forEach((c) => {
    c.vagas = { ...vagas };
    if (acumular) c.acumular = true; else delete c.acumular;
  });

  toast(alvos.length > 1 ? `Vagas aplicadas a ${alvos.length} datas.` : 'Vagas atualizadas.');
  atualizar();
}

function mudarMes(delta) {
  const [ano, mes] = estado.mes.split('-').map(Number);
  const nova = new Date(ano, mes - 1 + delta, 1);
  estado.mes = paraIso(nova).slice(0, 7);
  atualizar();
}

function atualizar() {
  salvar();
  renderizarTudo();
}

function pessoaPorId(id) {
  return estado.pessoas.find((p) => p.id === id);
}

function ligarEventos() {
  $('#formFuncao').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = $('#novaFuncao').value.trim();
    if (nome && !estado.funcoes.includes(nome)) estado.funcoes.push(nome);
    $('#novaFuncao').value = '';
    atualizar();
  });

  $('#formCulto').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = $('#dataCulto').value;
    if (!data) return;
    adicionarCulto(data, $('#turnoCulto').value);
    estado.mes = data.slice(0, 7);
    atualizar();
  });

  $('#addRecorrente').addEventListener('click', adicionarRecorrentes);

  $('#limparCultos').addEventListener('click', () => {
    if (!confirm('Remover todas as datas deste mês?')) return;
    estado.cultos = estado.cultos.filter((c) => !c.data.startsWith(estado.mes));
    delete estado.escalas[estado.mes];
    atualizar();
  });

  $('#formPessoa').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = $('#nomePessoa').value.trim();
    if (!nome) return;
    if (estado.pessoas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
      toast('Já existe uma pessoa com esse nome.');
      return;
    }
    estado.pessoas.push({ id: crypto.randomUUID(), nome, funcoes: [], indisponiveis: [] });
    $('#nomePessoa').value = '';
    atualizar();
  });

  $('#mesSelecionado').addEventListener('change', (e) => {
    if (e.target.value) { estado.mes = e.target.value; atualizar(); }
  });
  $('#mesTitulo').addEventListener('click', () => {
    const input = $('#mesSelecionado');
    try { input.showPicker(); } catch { input.focus(); }
  });
  document.querySelectorAll('.aba').forEach((aba) => aba.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((a) => a.classList.toggle('ativa', a === aba));
    document.querySelectorAll('.painel').forEach((p) => { p.hidden = p.dataset.painel !== aba.dataset.aba; });
  }));
  $('#dialogVagas').addEventListener('close', () => {
    if ($('#dialogVagas').returnValue === 'salvar') salvarVagas();
    cultoEmEdicao = null;
  });
  $('#formPar').addEventListener('submit', (e) => {
    e.preventDefault();
    const a = $('#parA').value;
    const b = $('#parB').value;
    if (!a || !b) return toast('Escolha as duas pessoas do par.');
    if (a === b) return toast('Escolha duas pessoas diferentes.');
    const existe = estado.pares.some((par) => (par.a === a && par.b === b) || (par.a === b && par.b === a));
    if (existe) return toast('Esse par já existe.');
    estado.pares.push({ id: crypto.randomUUID(), a, b });
    $('#parA').value = '';
    $('#parB').value = '';
    atualizar();
  });

  $('#exportarDados').addEventListener('click', exportarDados);
  $('#importarDados').addEventListener('click', () => $('#arquivoImportar').click());
  $('#arquivoImportar').addEventListener('change', async (e) => {
    await importarDados(e.target.files[0]);
    e.target.value = ''; // permite importar o mesmo arquivo de novo
  });
  $('#vagasFechar').addEventListener('click', () => $('#dialogVagas').close('cancelar'));
  $('#vagasPadrao').addEventListener('click', () => preencherCamposVagas(() => 1));
  $('#vagasCampos').addEventListener('click', (e) => {
    const botao = e.target.closest('button[data-passo]');
    if (!botao) return;
    const input = botao.parentElement.querySelector('input');
    input.value = Math.max(0, Math.min(20, (Number(input.value) || 0) + Number(botao.dataset.passo)));
  });
  $('#mesAnterior').addEventListener('click', () => mudarMes(-1));
  $('#mesSeguinte').addEventListener('click', () => mudarMes(1));

  $('#gerar').addEventListener('click', gerarEscala);
  $('#copiar').addEventListener('click', copiarTabela);
  $('#baixarCsv').addEventListener('click', baixarCsv);
  $('#imprimir').addEventListener('click', () => window.print());

  // Delegação: remoções, funções e indisponibilidades das pessoas
  document.body.addEventListener('click', (e) => {
    const alvo = e.target.closest('button');
    if (!alvo) return;
    const { removerFuncao, removerCulto, removerPessoa, removerPar, indisponivel, pessoa, vagas } = alvo.dataset;

    if (vagas) {
      abrirVagas(vagas);
    } else if (alvo.dataset.acumularFuncao !== undefined) {
      const f = alvo.dataset.acumularFuncao;
      estado.funcoesNaoAcumulaveis = funcaoAcumulavel(f)
        ? [...estado.funcoesNaoAcumulaveis, f]
        : estado.funcoesNaoAcumulaveis.filter((x) => x !== f);
      toast(funcaoAcumulavel(f) ? `${f} pode ser acumulada com outra função.` : `${f} não será acumulada com outra função.`);
      atualizar();
    } else if (removerPar) {
      estado.pares = estado.pares.filter((par) => par.id !== removerPar);
      atualizar();
    } else if (removerFuncao !== undefined) {
      const funcao = estado.funcoes[Number(removerFuncao)];
      estado.funcoes.splice(Number(removerFuncao), 1);
      estado.funcoesNaoAcumulaveis = estado.funcoesNaoAcumulaveis.filter((f) => f !== funcao);
      estado.pessoas.forEach((p) => { p.funcoes = p.funcoes.filter((f) => f !== funcao); });
      atualizar();
    } else if (removerCulto) {
      estado.cultos = estado.cultos.filter((c) => chaveCulto(c) !== removerCulto);
      delete escalaDoMes()[removerCulto];
      atualizar();
    } else if (removerPessoa) {
      const p = pessoaPorId(removerPessoa);
      if (p && confirm(`Remover ${p.nome}?`)) {
        estado.pessoas = estado.pessoas.filter((x) => x.id !== removerPessoa);
        estado.pares = estado.pares.filter((par) => par.a !== removerPessoa && par.b !== removerPessoa);
        atualizar();
      }
    } else if (indisponivel && pessoa) {
      const p = pessoaPorId(pessoa);
      p.indisponiveis = p.indisponiveis.includes(indisponivel)
        ? p.indisponiveis.filter((k) => k !== indisponivel)
        : [...p.indisponiveis, indisponivel];
      atualizar();
    }
  });

  document.body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('input[data-pessoa][data-funcao]')) {
      const p = pessoaPorId(el.dataset.pessoa);
      const f = el.dataset.funcao;
      p.funcoes = el.checked ? [...p.funcoes, f] : p.funcoes.filter((x) => x !== f);
      atualizar();
    } else if (el.matches('input[data-repetir]')) {
      pessoaPorId(el.dataset.repetir).podeRepetir = el.checked;
      atualizar();
    } else if (el.matches('select[data-celula]')) {
      // edição manual de uma célula da escala
      const escala = (estado.escalas[estado.mes] ||= {});
      const linha = (escala[el.dataset.celula] ||= {});
      const nomes = [...nomesDaCelula(linha, el.dataset.funcao)];
      nomes[Number(el.dataset.indice)] = el.value;
      linha[el.dataset.funcao] = Array.from(nomes, (n) => n || SEM_PESSOA);
      salvar();
      renderizarEscala();
    }
  });
}

/* ---------------- Início ---------------- */

function iniciar() {
  preencherTurnos($('#turnoCulto'));
  preencherTurnos($('#turnoRecorrente'));
  $('#diasSemana').innerHTML = DIAS_SEMANA.map((d, i) =>
    `<label class="dia-toggle" title="${d}"><input type="checkbox" value="${i}"><span>${d.slice(0, 3)}</span></label>`).join('');
  ligarEventos();
  renderizarTudo();
}

iniciar();
