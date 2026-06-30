// ==========================================
// REGRAS DE NEGÓCIO GLOBAIS (DRY)
// ==========================================
const IPSC_ZONES = { 'A': 5, 'C': 4, 'D': 2, 'M': -10, '-': 5 };
const IPSC_RANKS = { 'A': 4, 'C': 3, 'D': 2, '-': 1, 'M': -1 };
let startTime = 0;
let running = false;
// ==========================================
// PLUGIN: MOTOR DA AGULHA (MODO CLARO/ESCURO)
// ==========================================
const gaugeNeedlePlugin = {
    id: 'gaugeNeedle',
    afterDatasetDraw(chart) {
        const { ctx, chartArea: { width, height } } = chart;
        const meta = chart.getDatasetMeta(0);
        if (!meta.data.length) return;
        const arc = meta.data[0];
        const cx = arc.x; const cy = arc.y;
        const outerRadius = arc.outerRadius;
        const needleLength = outerRadius - 10;
        const dataset = chart.data.datasets[0];
        const value = dataset.needleValue || 0;
        const max = dataset.gaugeMax || 10;
        let percent = value / max;
        if (percent < 0) percent = 0; if (percent > 1) percent = 1;
        const angle = Math.PI + (percent * Math.PI);

        // MÁGICA DA COR: Lê diretamente a classe do body
        const isDark = document.body.classList.contains('dark-mode');
        const needleColor = isDark ? '#ffffff' : '#1a1a1a'; // Branco de noite, Preto de dia
        const centerColor = isDark ? '#212b36' : '#ffffff'; // Centro acompanha o fundo

        ctx.save();
        ctx.translate(cx, cy); ctx.rotate(angle);

        // Corpo da Agulha
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(needleLength, 0); ctx.lineTo(0, 4);
        ctx.fillStyle = needleColor; ctx.fill();

        // Círculo Base
        ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fillStyle = needleColor; ctx.fill();

        // Ponto Central Vazado
        ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fillStyle = centerColor; ctx.fill();

        ctx.restore();
    }
};
// função do campeonato
const MatchState = {
    isActive: false,
    totalStages: 0,
    currentStage: 1,
    athletes: [],
    currentAthleteIndex: 0,
    stagesData: []
};

// Função para mover a agulha com o Hit Factor
function atualizarGaugeIPSC(hf) {
    if (typeof gaugeChartIPSC !== 'undefined' && gaugeChartIPSC) {
        // Trava visualmente o limite em 10 para a agulha não dar a volta
        gaugeChartIPSC.data.datasets[0].needleValue = hf > 10 ? 10 : hf;
        gaugeChartIPSC.update();
    }
}
let shots = [];
let hfHistory = [];
let allRoundsShots = [];
let timeHistory = [];
let pointsHistory = [];
let sessionLabels = [];
let lastRoundShots = [];
let roundsCount = 0; // Contador de rodadas realizadas
let isAutoRunning = false;
let radarChart = null;
let myChart = null;
let gaugeChartIPSC = null;
let stopTimeout = null;
let isStopping = false;
let audioCtx = null;
try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
} catch (e) {
    console.warn("Motor de áudio bloqueado inicialmente.");
} let metallicTargets = new Set(); // Id alvos metalicos

// ==========================================
// 🛡️ PROTEÇÃO: MANTER TELA ACESA (WAKE LOCK)
// ==========================================
let wakeLock = null;

async function requestWakeLock() {
    try {
        // Checa se o navegador ou a conexão permite o Wake Lock antes de pedir
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('💡 Wake Lock ativado: A tela não vai mais apagar!');
        } else {
            console.log('⚠️ Wake Lock bloqueado (exige conexão HTTPS ou o navegador não suporta).');
        }
    } catch (err) {
        console.log(`Erro no Wake Lock: ${err.name}, ${err.message}`);
    }
}

// O navegador só permite manter a tela acesa se o usuário interagir com a página
document.addEventListener('click', requestWakeLock, { once: true });

// Se o usuário minimizar o navegador e voltar, pede o bloqueio de tela de novo
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
});

// --- MOTOR DE VOZ E PROTEÇÃO CONTRA GARBAGE COLLECTION ---
if ('speechSynthesis' in window && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

window.utterances = [];

function speakCoach(mensagem, callback) {
    let toggle = document.getElementById("voiceToggle");
    let triggerCallback = () => {
        if (callback && !callback.called) {
            callback.called = true;
            callback();
        }
    };

    if (!toggle || !toggle.checked) {
        setTimeout(triggerCallback, 1000);
        return;
    }

    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume(); // Destrava o motor de voz do Chrome/Android

        let msg = new SpeechSynthesisUtterance(mensagem);
        window.utterances.push(msg);

        msg.lang = 'pt-BR';
        msg.rate = 1.4; // Velocidade industrial para não atrasar o treino

        // Cria a função de limpeza e gatilho
        let clearAndTrigger = () => {
            window.utterances.length = 0; // <-- A MÁGICA: Limpa a RAM instantaneamente!
            triggerCallback();
        };

        msg.onend = clearAndTrigger;
        msg.onerror = clearAndTrigger; // Limpa em caso de erro também

        window.speechSynthesis.speak(msg);

        // SEGURO DE FLUXO: Se em 8 segundos a IA não terminar, força o início
        setTimeout(triggerCallback, 8000);
    } else {
        triggerCallback();
    }
}

// --- REDE NEURAL (TensorFlow.js) REMOVIDA PARA DESEMPENHO EXTREMO ---

// --- CONTROLE MANUAL DO DARK MODE ---
function toggleDarkMode() {
    let isDark = document.getElementById("darkModeToggle").checked;

    if (isDark) { document.body.classList.add("dark-mode"); }
    else { document.body.classList.remove("dark-mode"); }

    localStorage.setItem('darkModeState', isDark);

    if (typeof gaugeChartIPSC !== 'undefined' && gaugeChartIPSC !== null) {
        gaugeChartIPSC.update();
    }

    // MÁGICA DA FONTE: Muda a cor das letras do radar instantaneamente
    if (typeof radarChart !== 'undefined' && radarChart !== null) {
        radarChart.options.scales.r.pointLabels.color = isDark ? '#f9fafb' : '#1a1a1a';
        radarChart.update('none');
    }
}
window.addEventListener('load', () => {
    // 1. Restaura Configurações Salvas (Preferências do Atleta)
    try {
        // Limite de Disparos
        const valMaxShots = localStorage.getItem('maxShots');
        if (valMaxShots) {
            document.getElementById("maxShotsSel").value = valMaxShots;
            document.getElementById("label-maxShots").innerText = valMaxShots === '999' ? 'Irrestrito' : valMaxShots + ' Disparos';
        }

        // Modo Automático
        const valAutoMode = localStorage.getItem('autoMode');
        if (valAutoMode) {
            document.getElementById("autoModeSel").value = valAutoMode;
            let lbl = "Manual (Uma vez)";
            if (valAutoMode === '3') lbl = "Auto (3 Rodadas)";
            if (valAutoMode === '5') lbl = "Auto (5 Rodadas)";
            if (valAutoMode === '10') lbl = "Auto (10 Rodadas)";
            document.getElementById("label-autoMode").innerText = lbl;
        }

        // Modo de Pontuação (IPSC vs Ilimitado)
        const valScoreMode = localStorage.getItem('scoreMode');
        if (valScoreMode) {
            document.getElementById("scoreModeSel").value = valScoreMode;
            document.getElementById("label-scoreMode").innerText = valScoreMode === 'best2' ? 'REGRAS IPSC' : 'ILIMITADO';
        }

        // Tipo de Laser
        const valLaser = localStorage.getItem('laserType');
        if (valLaser) {
            document.getElementById("laserType").value = valLaser;
            document.getElementById("label-laserType").innerText = valLaser === '7' ? 'Laser Vermelho' : 'Infravermelho (IR)';
        }

        // Alvo Selecionado
        const valTarget = localStorage.getItem('targetSel');
        if (valTarget) {
            document.getElementById("targetSel").value = valTarget;
            document.getElementById("label-targetSel").innerText = valTarget === '255' ? 'Todos os Alvos' : 'Alvo ' + valTarget;
        }

        // Nome e Voz
        if (localStorage.getItem('athleteName')) document.getElementById("athleteName").value = localStorage.getItem('athleteName');
        if (localStorage.getItem('voiceState') !== null) document.getElementById("voiceToggle").checked = (localStorage.getItem('voiceState') === 'true');
    } catch (e) { console.warn("Aviso nas configurações:", e); }

    // 2. Inicializa o Gráfico de Performance (Linha)
    try {
        const ctx = document.getElementById('hfChart').getContext('2d');
        myChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sessionLabels,
                datasets: [{
                    label: 'Hit Factor',
                    data: hfHistory,
                    borderColor: '#D32F2F',
                    backgroundColor: 'rgba(211, 47, 47, 0.1)',
                    borderWidth: 3,
                    tension: 0.3,
                    fill: true,
                    pointRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { left: 5, right: 15, top: 10, bottom: 10 } },
                scales: {
                    y: {
                        beginAtZero: true,
                        min: 0, // <-- TRAVA O EIXO Y NO ZERO (NUNCA FICA NEGATIVO)
                        ticks: { color: '#888', font: { size: 14, weight: 'bold' } }
                    },
                    x: { ticks: { color: '#888', font: { size: 14, weight: 'bold' } } }
                },
                plugins: {
                    legend: { display: false } // <-- APAGA O RETÂNGULO VERMELHO
                },
                onClick: (event, elements) => {
                    if (elements.length > 0) loadRoundFromHistory(elements[0].index);
                }
            }
        });
    } catch (e) { console.error("Erro no Gráfico de Linha:", e); }

    // 3. Inicializa o Gráfico de Radar
    try {
        const ctxRadar = document.getElementById('radarChart').getContext('2d');
        radarChart = new Chart(ctxRadar, {
            type: 'radar',
            data: {
                // BASE DO RADAR: Tempo, HF e Pontos
                labels: ['Tempo (s)', 'Hit Factor', 'Pontos'],
                datasets: [
                    {
                        label: 'Rodada Atual',
                        backgroundColor: 'rgba(76, 175, 80, 0.3)',
                        borderColor: '#4CAF50',
                        pointBackgroundColor: '#4CAF50',
                        data: [0, 0, 0] // 3 zeros para as 3 pontas iniciais
                    },
                    {
                        label: 'Rodada Anterior',
                        backgroundColor: 'rgba(211, 47, 47, 0.3)',
                        borderColor: '#D32F2F',
                        pointBackgroundColor: '#D32F2F',
                        data: [0, 0, 0] // 3 zeros para as 3 pontas iniciais
                    }
                ]
            },

            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { left: 35, right: 35, top: 10, bottom: 10 } },
                scales: {
                    r: {
                        angleLines: { color: 'rgba(128,128,128,0.2)' },
                        grid: { color: 'rgba(128,128,128,0.2)' },
                        pointLabels: {
                            // Lê a cor inicial baseada no tema atual
                            color: document.body.classList.contains('dark-mode') ? '#f9fafb' : '#1a1a1a',
                            // Fonte grossa (900), legível e moderna
                            font: { size: 15, weight: '900', family: 'system-ui, sans-serif' }
                        },
                        ticks: { display: false }
                    }
                },
                plugins: {
                    legend: { position: 'top', labels: { color: 'var(--texto-sec)' } },
                    // MÁGICA: Engana o gráfico para mostrar o valor real em vez da percentagem
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                let label = context.dataset.label || '';
                                let realVal = context.dataset.realData ? context.dataset.realData[context.dataIndex] : context.raw;
                                let lblName = context.chart.data.labels[context.dataIndex];

                                // Formata Pontos sem casas decimais, e os restantes com 2 casas
                                let valStr = lblName === 'Pontos' ? Math.round(realVal) : Number(realVal).toFixed(2);
                                return `${label}: ${valStr}`;
                            }
                        }
                    }
                }
            }
        });
    } catch (e) { console.error("Erro no Gráfico de Radar:", e); }

    // 4. Inicializa o Gráfico de Pressão (Gauge)
    try {
        const ctxGauge = document.getElementById('gaugeChartIPSC');
        if (ctxGauge) {
            gaugeChartIPSC = new Chart(ctxGauge, {
                type: 'doughnut',
                plugins: [gaugeNeedlePlugin],
                data: {
                    datasets: [{
                        data: [3.33, 3.33, 3.34],
                        backgroundColor: ['#dc3545', '#ffc107', '#28a745'],
                        borderWidth: 0,
                        needleValue: 0,
                        gaugeMax: 10
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, rotation: -90, circumference: 180, cutout: '75%',
                    layout: { padding: { top: 25, left: 20, right: 20, bottom: 10 } },
                    plugins: { legend: { display: false }, tooltip: { enabled: false } }
                }
            });
        }
    } catch (e) { console.error("Erro no Gráfico Gauge:", e); }

    // 5. AGORA SIM! Com os gráficos já criados com segurança, damos o Reset.
    try { doReset(); } catch (e) { console.error("Erro no doReset:", e); }

    // 6. Restaura o Dark Mode
    try {
        if (localStorage.getItem('darkModeState') === 'true') {
            document.getElementById("darkModeToggle").checked = true;
            document.body.classList.add("dark-mode");
        }
    } catch (e) { console.warn("Erro no Dark Mode:", e); }

    // 7. Atualiza visibilidade do limite de disparos inicial
    try {
        atualizarVisibilidadeLimiteDisparos();
    } catch (e) { console.warn("Erro ao atualizar visibilidade inicial do limite:", e); }
});

// ==========================================
// COMUNICAÇÃO COM ESP32 (COM STATUS VISUAL)
// ==========================================
let _espOnline = null; // null = desconhecido ainda

function _updateConnectionStatus(online) {
    if (_espOnline === online) return; // sem mudança, não redesenha
    _espOnline = online;
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const offlineModal = document.getElementById('modal-offline');
    if (dot) dot.classList.toggle('online', online);
    if (label) label.textContent = online ? 'CONECTADO' : 'DESCONECTADO';
    if (offlineModal) offlineModal.style.display = online ? 'none' : 'flex';
}

function sendCmd(cmd, val) {
    let tgt = document.getElementById("targetSel")?.value || '255';
    fetch(`/cmd?target=${tgt}&${cmd}=${val}`)
        .then(r => {
            _updateConnectionStatus(r.ok);
        })
        .catch(() => {
            _updateConnectionStatus(false);
        });
}

// Verifica conexão ao carregar e a cada 10s (sem interferir no fetch real)
(function _pollConnection() {
    fetch('/cmd?target=255&ping=1')
        .then(r => _updateConnectionStatus(r.ok))
        .catch(() => _updateConnectionStatus(false));
    setTimeout(_pollConnection, 10000);
})();


function playBeep() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'square'; osc.frequency.setValueAtTime(3000, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
}

function prepareStart(isAuto = false) {
    // Limpa qualquer parada agendada ou flag de transição anterior
    if (stopTimeout) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
    }
    isStopping = false;

    let mode = document.getElementById("scoreModeSel")?.value || 'normal';
    let currentMax = (MatchState.isActive || mode === 'best2') ? getMatchRequiredShots() : parseInt(document.getElementById("maxShotsSel").value);
    // Se a rodada anterior tiver um número de tiros diferente do atual, limpa a referência
    if (lastRoundShots.length > 0 && lastRoundShots.length !== currentMax) {
        console.log("Configuração mudou: limpando referência de comparação.");
        lastRoundShots = [];
    } else if (shots.length > 0) {
        // Se for o mesmo número, salva a rodada que acabou de ocorrer como referência
        lastRoundShots = [...shots];
    }
    if (running) return; // Evita cliques duplos enquanto já está rodando

    // Salva a rodada anterior para comparação de setas antes de limpar
    if (shots.length > 0) {
        lastRoundShots = [...shots];
    }

    // Se for início manual (clique no botão), reseta o contador de rodadas automáticas
    if (!isAuto) {
        roundsCount = 0;
        isAutoRunning = false;
    } else {
        isAutoRunning = true;
    }

    shots = [];
    let btn = document.querySelector(".btn-start");
    btn.disabled = true;
    btn.innerText = isAuto ? "AUTO..." : "ATENÇÃO...";
    // O delay extra de 3s só acontece se for modo automático
    let autoDelay = isAuto ? 3000 : 0;

    setTimeout(() => {
        // 1. Limpa a tela principal e os textos
        document.getElementById("shotsBody").innerHTML = "";
        document.getElementById("hf").innerText = "0.00";
        document.getElementById("score").innerText = "0";
        document.getElementById("lastZone").innerText = "-";
        document.getElementById("lastZone").className = "giant-zone";
        document.getElementById("lastZone").style.color = "";

        // 2. ZERA OS NÚMEROS DO GRÁFICO DE BARRAS
        document.getElementById("vA").innerText = "0";
        document.getElementById("vC").innerText = "0";
        document.getElementById("vD").innerText = "0";
        document.getElementById("vX").innerText = "0";
        document.getElementById("vM").innerText = "0";
        document.getElementById("vE").innerText = "0";

        // 3. ZERA AS ALTURAS DAS BARRAS
        document.getElementById("bA").style.height = "0%";
        document.getElementById("bC").style.height = "0%";
        document.getElementById("bD").style.height = "0%";
        document.getElementById("bX").style.height = "0%";
        document.getElementById("bM").style.height = "0%";
        document.getElementById("bE").style.height = "0%";


        // 5. Beep e Início Real
        playBeep();
        running = true;
        startTime = Date.now();
        if (chronoFrameId) cancelAnimationFrame(chronoFrameId);
        chronoFrameId = requestAnimationFrame(updateChrono);

        // 6. Envia comando para o ESP32
        sendCmd("detect", 1);

        // 7. Restaura o botão
        btn.disabled = false;
        btn.innerText = "START";
        console.log("Iniciado - Rodada: " + (roundsCount + 1));
    }, (3000 + Math.random() * 2000) + autoDelay);
}

let renderPending = false;
function renderTable() {
    if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
            _renderTableReal();
            renderPending = false;
        });
    }
}
function _renderTableReal() {
    const elements = {
        shotsBody: document.getElementById("shotsBody"),
        score: document.getElementById("score"),
        hf: document.getElementById("hf"),
        lastZone: document.getElementById("lastZone"),
        chartView: document.getElementById("chartView"),
        vA: document.getElementById("vA"), vC: document.getElementById("vC"),
        vD: document.getElementById("vD"), vM: document.getElementById("vM"),
        vE: document.getElementById("vE"), vX: document.getElementById("vX"),
        bA: document.getElementById("bA"), bC: document.getElementById("bC"),
        bD: document.getElementById("bD"), bM: document.getElementById("bM"),
        bE: document.getElementById("bE"), bX: document.getElementById("bX"),
        wrapM: document.getElementById("wrap-M"),
        wrapE: document.getElementById("wrap-E"),
        wrapX: document.getElementById("wrap-X"),
        scoreModeSel: document.getElementById("scoreModeSel")
    };

    if (!elements.shotsBody) return;

    let lastT = 0;
    let lZ = "-";

    const scoreMode = elements.scoreModeSel ? elements.scoreModeSel.value : 'normal';
    const isBestTwo = (scoreMode === "best2");

    const getSeta = (atual, anterior, inverter) => {
        if (anterior === undefined || anterior === null || atual === anterior)
            return '<span style="color:#888; font-size:0.8em; margin-left:5px;">—</span>';
        let melhor = inverter ? (atual < anterior) : (atual > anterior);
        return melhor ?
            '<span style="color:#28a745; font-size:0.8em; margin-left:5px;">▲</span>' :
            '<span style="color:#dc3545; font-size:0.8em; margin-left:5px;">▼</span>';
    };

    let targetGroups = {};

    // 1. Agrupa tiros atuais por alvo
    shots.forEach((s, index) => {
        if (!targetGroups[s.target]) targetGroups[s.target] = [];
        targetGroups[s.target].push({
            index: index,
            points: IPSC_ZONES[s.zone],
            zone: s.zone
        });
        if (s.zone !== 'M') lastT = s.totalTime;
        lZ = s.zone;
    });

    // 2. Determina quais tiros contam e aplica PENALIDADES
    let countedIndices = new Set();
    let bestPoints = 0;

    for (let tId in targetGroups) {
        // Ordena do maior ponto para o menor
        let sortedShots = [...targetGroups[tId]].sort((a, b) => b.points - a.points);
        let limit = 999;

        if (isBestTwo) {
            limit = metallicTargets.has(parseInt(tId)) ? 1 : 2;
        }

        // A. Pega os tiros válidos e soma os pontos
        sortedShots.slice(0, limit).forEach(shotObj => {
            countedIndices.add(shotObj.index);
            bestPoints += shotObj.points;
        });
    }

    // 3. Renderização Visual com Setas
    let accPointsForHF = 0;
    let counts = { A: 0, C: 0, D: 0, M: 0, Metal: 0, Extra: 0 };
    const fragment = document.createDocumentFragment();
    let htmlRows = [];

    shots.forEach((s, i) => {
        let split = (i === 0) ? s.totalTime : (s.totalTime - shots[i - 1].totalTime);
        let isCounted = countedIndices.has(i);

        // Contabilização para os gráficos de barra
        if (s.zone === 'M') {
            counts.M++;
        } else if (!isCounted) {
            counts.Extra++;
        } else {
            if (s.zone === 'A') counts.A++;
            else if (s.zone === 'C') counts.C++;
            else if (s.zone === 'D') counts.D++;
            else if (s.zone === '-') counts.Metal++;
        }

        if (s.zone !== 'M') lastT = s.totalTime;
        lZ = s.zone;

        // NOVO: Cálculo do HF momento a momento com as penalidades e escudo anti-falha
        if (isCounted) {
            // Puxa o ponto de forma segura. Se não achar, soma 0.
            accPointsForHF += (IPSC_ZONES[s.zone] !== undefined ? IPSC_ZONES[s.zone] : 0);
        } else {
            accPointsForHF -= 10; // Subtrai 10 pontos no acumulado do Hit Factor
        }

        // Permite pontuação e HF negativos para punir rigorosamente os Miss
        let pontosValidosHF = accPointsForHF;
        let hfMomentaneo = s.totalTime > 0 ? (pontosValidosHF / s.totalTime).toFixed(2) : "0.00";

        let sAnterior = (lastRoundShots && lastRoundShots[i]) ? lastRoundShots[i] : null;
        let splitAnterior = null;
        let hfAnterior = null;
        let zonaAnteriorRank = null;

        if (sAnterior) {
            splitAnterior = (i === 0) ? sAnterior.totalTime : (sAnterior.totalTime - lastRoundShots[i - 1].totalTime);
            zonaAnteriorRank = IPSC_RANKS[sAnterior.zone];

            let pontosAnteriorAteAqui = 0;
            for (let j = 0; j <= i; j++) {
                let zAnt = lastRoundShots[j].zone;
                let pAnt = IPSC_ZONES[zAnt] !== undefined ? IPSC_ZONES[zAnt] : 0;
                pontosAnteriorAteAqui += pAnt;
            }
            pontosAnteriorAteAqui = pontosAnteriorAteAqui; // Permitir negativo
            hfAnterior = sAnterior.totalTime > 0 ? (pontosAnteriorAteAqui / sAnterior.totalTime).toFixed(2) : "0.00";
        }

        let setaZona = sAnterior ? getSeta(IPSC_RANKS[s.zone], zonaAnteriorRank, false) : "";
        let setaSplit = sAnterior ? getSeta(split, splitAnterior, true) : "";
        let setaHF = sAnterior ? getSeta(parseFloat(hfMomentaneo), parseFloat(hfAnterior), false) : "";
        let zoneDisplay = s.zone;
        let rowStyle = "";
        let statusIcon = isCounted ? "✅" : "❌";
        let valZonaClass = `color-${s.zone}`;

        if (s.zone === 'M') {
            zoneDisplay = `<span style="color:#D32F2F; font-weight:900;">MISS</span>`;
            rowStyle = "background-color: var(--bg-alerta);";
            valZonaClass = "";

            // LIMPEZA DO MISS: Tira o check verde e os traços inúteis
            statusIcon = "❌";
            setaZona = "";
            setaSplit = "";
            setaHF = "";
        } else if (s.zone === '-') {
            // O traço vira um 'M' Cinza para o metálico
            zoneDisplay = `<span style="color:#9E9E9E; font-weight:900;">M</span>`;
            valZonaClass = "";
        }

        // Mostra a penalidade na tabela claramente (Tiros Extras)
        if (!isCounted && s.zone !== 'M') {
            rowStyle += " color: #D32F2F; opacity: 0.85; text-decoration: line-through;";
            // Em vez de dois 'X', usamos um badge profissional indicando que foi um tiro extra penalizado
            statusIcon = `<span style="font-size: 0.65rem; background: #D32F2F; color: #fff; padding: 2px 6px; border-radius: 4px; font-weight: 900; margin-left: 6px; vertical-align: middle; text-decoration: none; display: inline-block;">EXTRA</span>`;
        }

        htmlRows.push(`<tr style="${rowStyle}">
            <td style="font-size: 0.9em;">#${i + 1} ${s.target !== '-' ? '(Alvo ' + s.target + ')' : ''}</td>
            <td class="${valZonaClass}">
                ${zoneDisplay} ${statusIcon} ${setaZona}
            </td>
            <td>${split.toFixed(2)}s ${setaSplit}</td>
            <td>${hfMomentaneo} ${setaHF}</td> 
          </tr>`);
    });

    // 4. Atualiza DOM Final

    document.getElementById("score").innerText = bestPoints;
    let finalHF = lastT > 0 ? (bestPoints / lastT).toFixed(2) : "0.00";

    document.getElementById("hf").innerText = finalHF;
    // Dispara a animação do velocímetro
    if (typeof atualizarGaugeIPSC === "function") atualizarGaugeIPSC(parseFloat(finalHF));
    const lastZoneEl = document.getElementById("lastZone");
    lastZoneEl.innerText = lZ;
    lastZoneEl.className = "giant-zone";

    // Deixa o letreiro gigante da última zona cinza caso seja metal
    if (lZ === '-') {
        lastZoneEl.style.color = "#9E9E9E";
    } else {
        lastZoneEl.style.color = "";
        lastZoneEl.classList.add("color-" + lZ);
    }

    // Atualiza Gráfico de Barras
    let total = shots.length;
    if (total > 0) {
        let cA = 0, cC = 0, cD = 0, cM = 0, cMetal = 0, cExtra = 0;
        shots.forEach((s, i) => {
            let isCounted = countedIndices.has(i);
            if (s.zone === 'M') {
                cM++;
            } else if (!isCounted) {
                cExtra++;
            } else {
                if (s.zone === 'A') cA++;
                else if (s.zone === 'C') cC++;
                else if (s.zone === 'D') cD++;
                else if (s.zone === '-') cMetal++;
            }
        });

        document.getElementById("vA").innerText = cA;
        document.getElementById("vC").innerText = cC;
        document.getElementById("vD").innerText = cD;
        document.getElementById("vM").innerText = cM;
        document.getElementById("vE").innerText = cExtra;

        // Extra hit
        document.getElementById("vX").innerText = cMetal;

        document.getElementById("chartView").style.display = "flex";

        // MÁGICA: Esconde as barras zeradas para manter a tela limpa
        let wrapM = document.getElementById("wrap-M");
        if (wrapM) wrapM.style.display = (cM > 0) ? "flex" : "none";

        let wrapE = document.getElementById("wrap-E");
        if (wrapE) wrapE.style.display = (cExtra > 0) ? "flex" : "none";

        // Se você tiver um wrapper para o metálico no seu HTML (ex: wrap-X), ele esconde também
        let wrapX = document.getElementById("wrap-X");
        if (wrapX) wrapX.style.display = (cMetal > 0) ? "flex" : "none";

        // Atualiza a altura das barras baseada no total de tiros da rodada

        document.getElementById("shotsBody").innerHTML = htmlRows.join('');
        document.getElementById("bA").style.height = ((cA / total) * 100) + "%";
        document.getElementById("bC").style.height = ((cC / total) * 100) + "%";
        document.getElementById("bD").style.height = ((cD / total) * 100) + "%";
        document.getElementById("bM").style.height = ((cM / total) * 100) + "%";
        document.getElementById("bE").style.height = ((cExtra / total) * 100) + "%";
        document.getElementById("bX").style.height = ((cMetal / total) * 100) + "%";
    }
}
function doStop() {
    if (!running || isStopping) return;
    isStopping = true;

    // Envia o comando para parar imediatamente no hardware (evita novos registros de impacto)
    sendCmd("detect", 0);
    playBeep();

    // Sênior Tip: Introduzimos uma janela de tolerância de 450ms (Grace Period) para rede.
    // Isso garante que disparos residuais que estavam em trânsito no Wi-Fi ou na fila do ESP32
    // cheguem, sejam renderizados e contabilizados antes de fecharmos a rodada!
    if (stopTimeout) clearTimeout(stopTimeout);

    stopTimeout = setTimeout(() => {
        isStopping = false;
        if (!running) return;
        running = false;

        // LÓGICA DE MISS (MANTIDA INTACTA)
        const scoreMode = document.getElementById("scoreModeSel").value;
        const maxShots = (MatchState.isActive || scoreMode === 'best2') ? getMatchRequiredShots() : parseInt(document.getElementById("maxShotsSel").value);
        let validos = countValidShots();

        if (scoreMode === 'best2' && maxShots !== 999 && validos < maxShots) {
            const missingCount = maxShots - validos;
            const lastShotTime = shots.length > 0 ? shots[shots.length - 1].totalTime : 0;
            for (let i = 0; i < missingCount; i++) {
                shots.push({ zone: 'M', totalTime: lastShotTime, target: '-', generated: true });
            }
            renderTable();
        }

        // FECHAMENTO DA RODADA
        if (shots.length > 0) {
            let finalHF = parseFloat(document.getElementById("hf").innerText);
            let finalPoints = parseInt(document.getElementById("score").innerText);
            let finalTime = shots[shots.length - 1].totalTime.toFixed(2);

            // EXCLUSÃO DA RODADA MAIS VELHA (Treino Livre)
            if (hfHistory.length >= 99) {
                hfHistory.shift();
                timeHistory.shift();
                pointsHistory.shift();
                sessionLabels.shift();
                allRoundsShots.shift();
            }

            // 🛡️ INTERCEPTAÇÃO ÚNICA E BLINDADA DA MÁQUINA DE ESTADOS (MODO COMPETIÇÃO)
            if (MatchState.isActive) {
                // Fala o tempo, hf e pontos no Modo Competição
                // Removemos zeros desnecessários no final para garantir pronúncia natural (ex: 1.2 -> "1 ponto 2")
                let tempoStrVoz = parseFloat(finalTime).toString().replace('.', ' ponto ');
                let hfStrVoz = parseFloat(finalHF.toFixed(2)).toString().replace('.', ' ponto ');
                speakCoach(`tempo ${tempoStrVoz}, fator ${hfStrVoz} ${finalPoints} pontos`);

                // CORREÇÃO: Função chamada com "c" (processar)
                processarStageCompeticao(finalPoints, parseFloat(finalTime), parseFloat(finalHF));
            } else {
                // Fluxo normal do Treino Livre
                allRoundsShots.push([...shots]);
                hfHistory.push(finalHF);
                timeHistory.push(finalTime);
                pointsHistory.push(finalPoints);

                let nextRoundNum = sessionLabels.length > 0 ? parseInt(sessionLabels[sessionLabels.length - 1].replace("R", "")) + 1 : 1;
                sessionLabels.push("R" + nextRoundNum);

                if (document.getElementById("hfChartArea")) document.getElementById("hfChartArea").style.display = "block";
                if (myChart) myChart.update('none');

                runAICoach().catch(e => console.log(e));
            }
        }
    }, 450);
}
function showToast(msg) {
    const x = document.getElementById('toast');
    if (!x) return;
    x.textContent = msg;
    x.classList.add('show');
    clearTimeout(x._hideTimer);
    x._hideTimer = setTimeout(() => x.classList.remove('show'), 3500);
}
function doReset() {
    running = false;
    roundsCount = 0;

    // AQUI ESTAVA O ERRO: Removemos a linha que apagava a lista de alvos.
    // Os alvos pareados (e a matriz) agora permanecem intactos.

    // 1. Limpa toda a memória de treino do navegador (Históricos completos)
    hfHistory.length = 0;
    timeHistory.length = 0;
    pointsHistory.length = 0;
    sessionLabels.length = 0;
    allRoundsShots = [];
    shots = [];
    processedSeqs.clear(); // Limpa sequências duplicadas no reset do treino

    // 2. Limpa o armazenamento do recorde pessoal
    localStorage.removeItem('pb_hf');

    // 3. Reset Visual da Tabela e Textos Principais
    document.getElementById("shotsBody").innerHTML = "";
    document.getElementById("hf").innerText = "0.00";
    document.getElementById("score").innerText = "0";
    document.getElementById("chrono").innerText = "0.0";
    document.getElementById("lastZone").innerText = "-";
    document.getElementById("lastZone").className = "giant-zone";
    document.getElementById("lastZone").style.color = "";

    // 4. Reset do Gráfico de Barras (Zera visualmente)
    const barras = ['A', 'C', 'D', 'X', 'M', 'E'];
    barras.forEach(v => {
        let valEl = document.getElementById("v" + v);
        let barEl = document.getElementById("b" + v);
        if (valEl) valEl.innerText = "0";
        if (barEl) barEl.style.height = "0%";
    });

    // 5. Reset do Gráfico de Linha (Evolução)
    if (myChart) {
        myChart.data.datasets[0].data.length = 0;
        myChart.data.labels.length = 0;
        myChart.update('none');
    }

    // 6. Reset do Gráfico de Radar
    if (radarChart) {
        radarChart.data.datasets[0].data = [0, 0, 0];
        radarChart.data.datasets[1].data = [0, 0, 0];
        radarChart.update('none');
    }

    // 7. Reset do Gráfico de Pressão (Agulha)
    if (gaugeChartIPSC !== null) {
        gaugeChartIPSC.data.datasets[0].needleValue = 0;
        atualizarGaugeIPSC(0);
    }

    // 8. Avisa o Hardware para zerar a fila e o cronômetro
    if (typeof sendCmd === "function") {
        sendCmd("cmd", 5);
    }

    showToast("🧹 Gráficos limpos e sistema pronto! Alvos mantidos.");
}
// ==========================================
// MODAL DE CALIBRAÇÃO
// ==========================================
function abrirModalCalibracao() {
    document.getElementById('modal-calibracao').style.display = 'flex';
    // Força a atualização do texto e dos desenhos pro valor atual do Select
    atualizarInstrucoesCalibracao();
}

function fecharModalCalibracao() {
    document.getElementById('modal-calibracao').style.display = 'none';
}

function confirmarCalibracao() {
    fecharModalCalibracao(); // Fecha a janela primeiro
    let laserMode = document.getElementById("laserType").value;
    let tgt = document.getElementById("targetSel").value;

    // NOVO: Lê a quantidade de disparos escolhida (1 ou 2)
    let calibMode = document.getElementById("calibLimitSel").value;

    // Injeta o calibMode na URL de envio
    fetch(`/cmd?target=${tgt}&calib=${calibMode}&laserMode=${laserMode}`)
        .then(() => {
            let msgTiros = calibMode === "2" ? "10 disparos" : "5 disparos";
            showToast(`✨ Calibração iniciada (${msgTiros})! Siga o protocolo luminoso nos alvos.`);
        })
        .catch(e => showToast("❌ Erro de comunicação ao tentar calibrar."));
}
function doMetalico() {
    let tgt = parseInt(document.getElementById("targetSel").value);
    // Usa o fetch direto igual na calibração para não ter erro
    fetch(`/cmd?target=${tgt}&cmd=12`).catch(e => { });

    if (tgt === 255) {
        document.querySelectorAll('.ipsc-wrapper').forEach(el => {
            let idStr = el.id.replace('wrapper-tgt-', '');
            metallicTargets.add(parseInt(idStr));
            atualizarMatrizVisual(idStr);
        });
        showToast("🎯 Todos os alvos definidos como METÁLICO!");
    } else {
        metallicTargets.add(tgt);
        atualizarMatrizVisual(tgt.toString());
        showToast(`🎯 Alvo ${tgt} definido como METÁLICO!`);
    }
}

function doIPSC() {
    let tgt = parseInt(document.getElementById("targetSel").value);
    // Usa o fetch direto igual na calibração para não ter erro
    fetch(`/cmd?target=${tgt}&cmd=13`).catch(e => { });

    if (tgt === 255) {
        metallicTargets.clear();
        document.querySelectorAll('.ipsc-wrapper').forEach(el => {
            let idStr = el.id.replace('wrapper-tgt-', '');
            atualizarMatrizVisual(idStr);
        });
        showToast("🎯 Todos os alvos definidos como PAPEL (IPSC)!");
    } else {
        if (metallicTargets.has(tgt)) {
            metallicTargets.delete(tgt);
            atualizarMatrizVisual(tgt.toString());
        }
        showToast(`🎯 Alvo ${tgt} definido como PAPEL (IPSC)!`);
    }
}
function playMetalSound() {
    let soundToggle = document.getElementById("soundToggle");
    if (soundToggle && !soundToggle.checked) return; // Se estiver mudo, corta o som metálico também

    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;

    // --- 1. O IMPACTO (Ruído Branco / "Crack") ---
    // Isso simula o barulho seco da bala batendo
    const bufferSize = audioCtx.sampleRate * 0.1;
    // 0.1 segundos de barulho
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1; // Gera chiado aleatório
    }

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = audioCtx.createGain();

    //para deixar o impacto mais seco
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 500;

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);

    // Volume do impacto: alto e corta rápido
    noiseGain.gain.setValueAtTime(1.0, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
    noise.start(now);

    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const metalGain = audioCtx.createGain();

    // Frequências ajustadas para parecer um prato de IPSC (mais agudo)
    osc1.type = 'square'; // Som metálico
    osc2.type = 'sine';   // Som puro (o "tiiim" final)

    osc1.frequency.setValueAtTime(800, now); // Frequência base
    osc2.frequency.setValueAtTime(2300, now); // Harmônico agudo

    // Decaimento (o som sumindo)
    metalGain.gain.setValueAtTime(0.3, now);
    metalGain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);

    osc1.connect(metalGain);
    osc2.connect(metalGain);
    metalGain.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.5);
    osc2.stop(now + 0.5);
}

let ws;
let processedSeqs = new Set();
window.addEventListener('offline', () => {
    document.body.style.border = "none";
    document.body.style.boxShadow = "inset 0 0 0 8px orange, inset 0 0 50px rgba(255, 165, 0, 0.5)";
    showToast("⚠️ WIFI DESCONECTADO! Verifique a rede 360 IPS Metrix.");
});
window.addEventListener('online', () => {
    showToast("🌐 Wifi detectado. Reconectando ao 360 IPS Metrix...");
    // A borda só sai quando o WebSocket de fato abrir (onopen)
});

function conectarRádio() {
    ws = new WebSocket(`ws://${location.hostname}:81`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
        console.log("🟢 Conectado!");
        showToast("✅ Metrix Online!");
        document.body.style.border = "none";
        document.body.style.boxShadow = "none";
        processedSeqs.clear(); // Limpa cache de sequências ao conectar para evitar travamento pós-reboot do ESP32
    };

    ws.onclose = () => {
        // Remove a borda física que empurrava o layout e desalinhava a tela
        document.body.style.border = "none";
        // Cria a borda laranja e o brilho desenhando POR DENTRO da tela (inset)
        document.body.style.boxShadow = "inset 0 0 0 8px orange, inset 0 0 50px rgba(255, 165, 0, 0.5)";

        // Tenta reconectar a cada 1 segundo
        setTimeout(conectarRádio, 1000);
    };
    ws.onmessage = (e) => {
        let j;
        if (e.data instanceof ArrayBuffer) {
            const view = new DataView(e.data);
            const msgType = view.getUint8(0);
            if (msgType === 1) { 
                j = {
                    type: "shot",
                    seq: view.getUint32(1, true),
                    zone: String.fromCharCode(view.getUint8(5)),
                    split: view.getUint16(6, true),
                    time: view.getUint32(8, true),
                    target: view.getUint8(12)
                };
            } else { return; }
        } else {
            j = JSON.parse(e.data);
        }

        if (j.type === "master_status") {
            atualizarBateriaMaster(j.bat);
            if (j.bat <= 20) showToast(`⚠️ Bateria do Metrix Crítica: ${j.bat}%!`);
            return;
        }

        if (j.type === "target_detected" || j.type === "new_target") {
            let tgtId = j.id !== undefined ? j.id : j.target;
            ensureTargetExists(tgtId);
            return;
        }

        if (j.type === "shot" && j.target) {
            ensureTargetExists(j.target);
        }

        if (j.type === "shot") {
            if (j.seq) {
                ws.send("ACK:" + j.seq);
                if (processedSeqs.has(j.seq)) return;
                processedSeqs.add(j.seq);
            }

            if (running) {
                let tempoChegada = (Date.now() - startTime) / 1000;
                let splitReal = shots.length > 0 ? tempoChegada - shots[shots.length - 1].totalTime : tempoChegada;

                let targetId = parseInt(j.target);
                if (isNaN(targetId) || targetId <= 0 || targetId > 255) return;


                let ehPrimeiroTiroNoAlvo = !shots.some(s => s.target === targetId);

                if (shots.length > 0) {
                    if (j.split !== undefined) {
                        if (j.split > 0 && (j.split / 1000) < 0.050) return; // Limite físico de bounce no mesmo sensor
                    } else {
                        // Se não tem j.split, usa o split da rede, mas não descarta se for o 1º tiro no alvo (transição)
                        if (splitReal < 0.050 && !ehPrimeiroTiroNoAlvo) return;
                    }
                }

                if (metallicTargets.has(targetId)) {
                    playMetalSound();
                    j.zone = '-';
                }

                // Correção: No modo Match (Competição), o cronômetro NÃO deve parar automaticamente (igual na vida real e no Treino Livre).
                // Ele deve continuar aceitando transições para os próximos alvos até que o RO aperte STOP manualmente.
                let mode = document.getElementById("scoreModeSel").value;
                let max;
                if (MatchState.isActive) {
                    max = 999;
                } else if (mode === 'best2') {
                    max = getMatchRequiredShots();
                } else {
                    max = parseInt(document.getElementById("maxShotsSel").value);
                }
                let currentValid = (mode === 'best2') ? countValidShots() : shots.length;

                if (max === 999 || currentValid < max) {
                    shots.push({
                        zone: j.zone,
                        totalTime: (Date.now() - startTime) / 1000,
                        target: targetId,
                    });

                    dispararFlashIPSC(targetId, j.zone);
                    renderTable();
                    atualizarRadarEmTempoReal(); // <--- INJETADO AQUI: Atualiza a cada tiro!

                    let newValid = (mode === 'best2') ? countValidShots() : shots.length;
                    if (max !== 999 && newValid >= max) {
                        doStop();
                    }
                }
            }
        }
    };
    ws.onerror = (err) => {
        ws.close(); // Força o onclose para disparar a reconexão
    };
}

// Inicia a conexão pela primeira vez quando a página carrega
conectarRádio();
// =========================================
// MOTOR DO CRONÔMETRO (1 CASA DECIMAL: 0:00.0)
// =========================================
let chronoFrameId = null;
function updateChrono() {
    if (!running) return;
    let seconds = (Date.now() - startTime) / 1000;

    // Se passou de 1 minuto, mostra 1:05.2. Se não, mostra só 5.2
    if (seconds >= 60) {
        let m = Math.floor(seconds / 60);
        // toFixed(1) deixa 1 casa decimal. padStart(4, '0') garante os zeros (ex: "05.2")
        let s = (seconds % 60).toFixed(1).padStart(4, '0');
        document.getElementById("chrono").innerText = m + ":" + s;
    } else {
        document.getElementById("chrono").innerText = seconds.toFixed(1);
    }
    chronoFrameId = requestAnimationFrame(updateChrono);
}

function toggleSend(type, isChecked) { sendCmd(type, isChecked ? 1 : 0); }

function getInd(cur, prev, lowerIsBetter) {
    if (prev === null || cur === prev) return "—";
    if (lowerIsBetter) {
        return cur < prev ? '<span style="color:green">▲</span>' : '<span style="color:red">▼</span>';
    }
    return cur > prev ? '<span style="color:green">▲</span>' : '<span style="color:red">▼</span>';
}

function saveSettings() {
    // Inputs padrão (Com escudo anti-falha)
    let maxShotsSel = document.getElementById("maxShotsSel");
    if (maxShotsSel) localStorage.setItem('maxShots', maxShotsSel.value);

    let autoModeSel = document.getElementById("autoModeSel");
    if (autoModeSel) localStorage.setItem('autoMode', autoModeSel.value);

    let scoreModeSel = document.getElementById("scoreModeSel");
    if (scoreModeSel) localStorage.setItem('scoreMode', scoreModeSel.value);

    let laserType = document.getElementById("laserType");
    if (laserType) localStorage.setItem('laserType', laserType.value);

    let athleteName = document.getElementById("athleteName");
    if (athleteName) {
        let sanitized = athleteName.value.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s]/g, '');
        if (athleteName.value !== sanitized) athleteName.value = sanitized;
        localStorage.setItem('athleteName', sanitized);
    }

    let targetSel = document.getElementById("targetSel");
    if (targetSel) localStorage.setItem('targetSel', targetSel.value);

    // Toggles (Checkbox) - Escudo contra o erro 'null'
    let voiceToggle = document.getElementById("voiceToggle");
    if (voiceToggle) localStorage.setItem('voiceState', voiceToggle.checked);

    let soundToggle = document.getElementById("soundToggle");
    if (soundToggle) localStorage.setItem('soundState', soundToggle.checked);

    let lightToggle = document.getElementById("lightToggle");
    if (lightToggle) localStorage.setItem('lightState', lightToggle.checked);

    let darkModeToggle = document.getElementById("darkModeToggle");
    if (darkModeToggle) localStorage.setItem('darkModeState', darkModeToggle.checked);
}

function loadRoundFromHistory(index) {
    const historyData = allRoundsShots[index];
    if (historyData) {
        // Substitui os disparos atuais pelos históricos e redesenha a interface
        shots = [...historyData];
        renderTable();

        // Feedback visual: destaca que estamos vendo um dado antigo
        const hfEl = document.getElementById("hf");
        hfEl.style.textDecoration = "underline";
        setTimeout(() => hfEl.style.textDecoration = "none", 1000);

        // Rola a página para a tabela automaticamente no mobile
        document.querySelector(".right-column").scrollIntoView({ behavior: 'smooth' });
    }
}

function shareResults() {
    if (hfHistory.length === 0) {
        showToast("⚠️ Nenhum dado para compartilhar!");
        return;
    }

    let atleta = document.getElementById("athleteName").value || "Atleta";
    let conteudo = "=== RELATÓRIO DE TREINO IPS Metrix ===\n";
    conteudo += "Atleta: " + atleta + "\n";
    conteudo += "Data: " + new Date().toLocaleString() + "\n\n";

    hfHistory.forEach((hf, i) => {
        conteudo += `${sessionLabels[i]}: HF ${hf} | Pontos: ${pointsHistory[i]} | Tempo: ${timeHistory[i]}s\n`;
    });

    conteudo += "\nMelhor Hit Factor da sessão: " + Math.max(...hfHistory);

    const blob = new Blob([conteudo], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `treino_${atleta.replace(/\s+/g, '_').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    showToast("✅ Relatório TXT baixado com sucesso!");
}
function countValidShots() {
    let targetGroups = {};
    // Agrupa tiros atuais por alvo
    shots.forEach(s => {
        if (!targetGroups[s.target]) targetGroups[s.target] = [];
        targetGroups[s.target].push(s);
    });

    let validCount = 0;
    for (let tId in targetGroups) {
        // Se houver mais de um alvo no total, contamos apenas os 2 melhores de cada
        // Se houver apenas 1 alvo, a lógica de "2 melhores" ainda se aplica para o Stop
        let shotsInTarget = targetGroups[tId].length;
        let limiteDesteAlvo = metallicTargets.has(parseInt(tId)) ? 1 : 2;
        validCount += Math.min(shotsInTarget, limiteDesteAlvo);
    }
    return validCount;
}

function getMatchRequiredShots() {
    let targetWrappers = document.querySelectorAll('.ipsc-wrapper');
    let targetIds = Array.from(targetWrappers).map(el => parseInt(el.id.replace('wrapper-tgt-', ''))).filter(id => !isNaN(id));
    if (targetIds.length === 0) return 999;
    let total = 0;
    targetIds.forEach(id => {
        total += metallicTargets.has(id) ? 1 : 2;
    });
    return total;
}

function handleNewShot(newShotData) {
    if (!running) return;

    shots.push(newShotData);
    renderTable();

    const scoreMode = document.getElementById("scoreModeSel").value;
    let maxAllowed;
    if (scoreMode === 'best2') {
        maxAllowed = getMatchRequiredShots();
    } else {
        maxAllowed = parseInt(document.getElementById("maxShotsSel").value);
    }
    let stopTriggered = false;

    if (scoreMode === "best2") {
        // Conta apenas até 2 tiros por alvo (ou 1 se for metal)
        let validCount = 0;
        let targetGroups = {};
        shots.forEach(s => {
            if (!targetGroups[s.target]) targetGroups[s.target] = 0;
            let limit = metallicTargets.has(parseInt(s.target)) ? 1 : 2;
            if (targetGroups[s.target] < limit) {
                targetGroups[s.target]++;
                validCount++;
            }
        });
        if (validCount >= maxAllowed) stopTriggered = true;
    } else {
        // Modo Tradicional: para no número exato de disparos feitos
        if (shots.length >= maxAllowed) stopTriggered = true;
    }

    if (stopTriggered) {
        running = false;
        sendCmd("detect", 0);
        if (isAutoRunning) {
            setTimeout(() => { if (isAutoRunning) prepareStart(true); }, 5000);
        }
    }
}

function identificarAlvo() {
    let sel = document.getElementById("targetSel");
    let targetId = sel.value;

    // Envia o comando 10 para ligar o LED (SOU_EU)
    sendCmd("cmd", 10);
    console.log(`Comando 10 enviado para o Alvo ${targetId}`);

    // Cria um timer para enviar o comando 11 (STOP_ID) e apagar os LEDs após 3 segundos
    setTimeout(() => {
        sendCmd("cmd", 11);
        console.log(`Comando 11 (Desligar) enviado para o Alvo ${targetId}`);
    }, 3000);
}

function ensureTargetExists(targetId, silent = false) {
    let idStr = String(targetId);
    if (!idStr || idStr === '-' || idStr === '255' || idStr === '0' || idStr === 'null' || idStr === 'undefined') return false;

    // MÁGICA 1 (A CORREÇÃO DO CRASH): Verifica se o botão já existe no modal novo
    if (document.getElementById(`btn-tgt-modal-${idStr}`)) return false;

    // MÁGICA 2: Injeta o botão no Modal Digital
    const listContainer = document.getElementById('list-targets-modal');
    if (listContainer) {
        listContainer.insertAdjacentHTML('beforeend', `<button id="btn-tgt-modal-${idStr}" onclick="updateSelection('targetSel', '${idStr}', 'Alvo ${idStr}')" class="btn-modal-option">🎯 ALVO ${idStr}</button>`);
    }

    if (!silent) showToast("🎯 Alvo " + idStr + " pareado e registrado na telemetria.");

    // MÁGICA 3: Dá uma piscada verde no botão principal de Alvos para avisar
    let btnPrincipal = document.querySelector(`button[onclick="abrirModal('modal-target-sel')"]`);
    if (btnPrincipal) {
        btnPrincipal.style.boxShadow = "0 0 15px #4CAF50";
        setTimeout(() => btnPrincipal.style.boxShadow = "inset 0 2px 5px rgba(0,0,0,0.05)", 800);
    }

    // Desenha o papelão na Matriz Tática
    adicionarAlvoNaMatriz(idStr);

    return true;
}

// --- EXCEL (CSV) PROFISSIONAL ---
function saveRoundToCSV() {
    if (allRoundsShots.length === 0 && shots.length === 0) {
        showToast("⚠️ Nenhum dado de treino para exportar.");
        return;
    }

    let atleta = document.getElementById("athleteName").value || "Atleta Anônimo";
    let dataHoje = new Date().toLocaleString('pt-BR');
    let hfMax = hfHistory.length > 0 ? Math.max(...hfHistory).toFixed(2).replace('.', ',') : "0,00";

    let csvContent = "\uFEFF";

    // 1. Cabeçalho Principal
    csvContent += "=== RELATÓRIO OFICIAL DE TREINO - STORM X IPSC ===\n";
    csvContent += `Atleta:;${atleta}\n`;
    csvContent += `Data:;${dataHoje}\n`;
    csvContent += `Melhor Hit Factor:;${hfMax}\n\n`;

    // 2. Extração de Insights do 360 AI Analyst
    let aiTextRaw = document.getElementById("aiFeedback") ? document.getElementById("aiFeedback").innerText : "";
    let linhasAI = aiTextRaw.split('\n').map(l => l.trim()).filter(l => l.length > 5);

    if (linhasAI.length > 0) {
        csvContent += "=== DIAGNÓSTICO DO 360 AI ANALYST ===\n";
        linhasAI.forEach(linha => {
            // Remove o ponto e vírgula nativo para não quebrar colunas do CSV e injeta o texto na célula
            let textoSeguro = linha.replace(/;/g, ',');
            csvContent += `Insight:;${textoSeguro}\n`;
        });
        csvContent += "\n";
    }

    // 3. Tabela de Tiros
    csvContent += "Rodada;Hit Factor;Tempo Total;Tiro #;Alvo;Zona;Pontos;Split (s);Tempo do Tiro (s)\n";

    allRoundsShots.forEach((rodada, rIdx) => {
        let hfRodada = hfHistory[rIdx] ? hfHistory[rIdx].toString().replace('.', ',') : "0,00";
        let tempoRodada = timeHistory[rIdx] ? timeHistory[rIdx].toString().replace('.', ',') : "0,00";

        rodada.forEach((s, sIdx) => {
            let split = (sIdx === 0) ? s.totalTime : (s.totalTime - rodada[sIdx - 1].totalTime);
            let pts = IPSC_ZONES[s.zone] !== undefined ? IPSC_ZONES[s.zone] : 0;
            let splitStr = split.toFixed(2).replace('.', ',');
            let tempoTiroStr = s.totalTime.toFixed(2).replace('.', ',');

            let showRndInfo = (sIdx === 0) ? `R${rIdx + 1};${hfRodada};${tempoRodada}` : `;;`;
            csvContent += `${showRndInfo};${sIdx + 1};${s.target};${s.zone};${pts};${splitStr};${tempoTiroStr}\n`;
        });
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Telemetria_IPSC_${atleta.replace(/\s+/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    showToast("✅ Planilha Profissional baixada com sucesso!");
}

// 1. Filtra apenas os disparos válidos (ignora os extras que sofreram penalidade)
function getValidShots(shotArray) {
    const scoreMode = document.getElementById("scoreModeSel").value;
    const isBestTwo = (scoreMode === "best2");
    let targetGroups = {};


    shotArray.forEach((s, index) => {
        if (!targetGroups[s.target]) targetGroups[s.target] = [];
        targetGroups[s.target].push({ ...s, originalIndex: index, points: IPSC_ZONES[s.zone] !== undefined ? IPSC_ZONES[s.zone] : 0 });
    });

    let validIndices = new Set();
    for (let tId in targetGroups) {
        let sorted = [...targetGroups[tId]].sort((a, b) => b.points - a.points);
        // Aplica a regra de limite (2 para papel, 1 para metal) apenas no modo IPSC
        let limit = isBestTwo ? (metallicTargets.has(parseInt(tId)) ? 1 : 2) : 999;
        sorted.slice(0, limit).forEach(shotObj => validIndices.add(shotObj.originalIndex));
    }
    // Retorna os tiros em ordem cronológica, mas apenas os que pontuaram
    return shotArray.filter((s, i) => validIndices.has(i));
}

// 2. Extrai as estatísticas matemáticas limpas
function extractStats(validShots) {
    let trans = [];
    let dtaps = [];

    for (let i = 1; i < validShots.length; i++) {
        if (validShots[i].target !== validShots[i - 1].target) {
            trans.push(validShots[i].totalTime - validShots[i - 1].totalTime);
        }
    }

    // Separa os Double Taps (O tempo exato entre o 1º e 2º tiro válido no mesmo alvo)
    let tgMap = {};
    validShots.forEach(s => {
        if (!tgMap[s.target]) tgMap[s.target] = [];
        tgMap[s.target].push(s.totalTime);
    });

    for (let t in tgMap) {
        if (tgMap[t].length >= 2) {
            dtaps.push(tgMap[t][1] - tgMap[t][0]); // Mede do 1º para o 2º tiro no alvo
        }
    }

    let avgTrans = trans.length > 0 ? trans.reduce((a, b) => a + b, 0) / trans.length : 0;
    let avgDT = dtaps.length > 0 ? dtaps.reduce((a, b) => a + b, 0) / dtaps.length : 0;

    return { avgTrans, avgDT };
}
function atualizarBateriaMaster(nivel) {
    const bar = document.getElementById("master-bat-bar");
    const text = document.getElementById("master-bat-text");

    if (bar && text) {
        bar.style.width = nivel + "%";
        text.innerText = nivel + "%";

        // Altera a cor baseada no nível
        if (nivel > 50) bar.style.backgroundColor = "#28a745"; // Verde
        else if (nivel > 20) bar.style.backgroundColor = "#ffc107"; // Amarelo
        else bar.style.backgroundColor = "#dc3545"; // Vermelho
    }
}
// Função para atualizar o nível de bateria na interface
function atualizarBateriaUI(id, nivel) {
    let barId = id === "master" ? "master-bat-bar" : `target-bat-bar-${id}`;
    let textId = id === "master" ? "master-bat-text" : `target-bat-text-${id}`;

    let bar = document.getElementById(barId);
    let text = document.getElementById(textId);

    if (bar && text) {
        bar.style.width = nivel + "%";
        text.innerText = nivel + "%";

        // Muda a cor conforme o nível
        if (nivel > 50) bar.style.backgroundColor = "#28a745"; // Verde
        else if (nivel > 20) bar.style.backgroundColor = "#ffc107"; // Amarelo
        else bar.style.backgroundColor = "#dc3545"; // Vermelho
    }
}

// --- GERAÇÃO DE PDF PROFISSIONAL OFFLINE ---
async function gerarPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let atleta = document.getElementById("athleteName").value || "Atleta Anônimo";

    // ==========================================
    // 1. CABEÇALHO PROFISSIONAL (PADRÃO AZUL)
    // ==========================================
    doc.setFontSize(22);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text("RELATÓRIO OFICIAL DE TREINO IPSC", 105, 20, { align: "center" });

    doc.setFontSize(11);
    doc.setTextColor(50, 50, 50);
    doc.setFont(undefined, 'normal');
    doc.text(`ATLETA: ${atleta.toUpperCase()}`, 15, 30);
    doc.text(`DATA: ${new Date().toLocaleString()}`, 15, 36);

    let hfMax = hfHistory.length > 0 ? Math.max(...hfHistory) : 0;
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text(`HIGH SCORE (HF): ${hfMax.toFixed(2)}`, 145, 33);
    doc.setFont(undefined, 'normal');

    // ==========================================
    // 2. DIAGNÓSTICO DO 360 AI ANALYST
    // ==========================================
    let yPos = 55;
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text("Diagnóstico Inteligente (360 AI Analyst):", 15, yPos);
    yPos += 8;

    let aiTextRaw = document.getElementById("aiFeedback") ? document.getElementById("aiFeedback").innerText : "Sem análise.";
    let linhasAI = aiTextRaw.split('\n').map(l => l.trim()).filter(l => l.length > 5);

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    
    if (linhasAI.length === 0) {
        doc.setTextColor(50, 50, 50);
        doc.text("Treinamento a seco insuficiente para diagnóstico.", 15, yPos);
        yPos += 10;
    } else {
        linhasAI.forEach(linha => {
            if (yPos > 270) { doc.addPage(); yPos = 20; }
            
            let textoLimpo = linha.replace(/[^\w\s.,;:!?()%"'áéíóúãõçÁÉÍÓÚÃÕÇ\-]/gi, "").trim();
            
            if (textoLimpo.includes("Gargalo") || textoLimpo.includes("Degradação") || textoLimpo.includes("FALHA")) {
                doc.setTextColor(220, 53, 69); // Vermelho
            } else if (textoLimpo.includes("Ponto Forte") || textoLimpo.includes("Evolução") || textoLimpo.includes("Recorde")) {
                doc.setTextColor(40, 167, 69); // Verde
            } else {
                doc.setTextColor(50, 50, 50); // Escuro base
            }

            let linhasWrap = doc.splitTextToSize(`• ${textoLimpo}`, 180);
            doc.text(linhasWrap, 15, yPos);
            yPos += (linhasWrap.length * 5) + 3;
        });
    }

    yPos += 5;

    // ==========================================
    // 3. TABELA DE RODADAS
    // ==========================================
    if (yPos > 240) { doc.addPage(); yPos = 20; }

    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text("Desempenho por Rodada:", 15, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFillColor(240, 240, 240); // Cinza Claro
    doc.rect(15, yPos, 180, 8, 'F');

    doc.setTextColor(0, 0, 0); // Preto
    doc.setFont(undefined, 'bold');
    doc.text("Rodada", 18, yPos + 6);
    doc.text("Alfas", 40, yPos + 6);
    doc.text("Charlies", 55, yPos + 6);
    doc.text("Deltas", 75, yPos + 6);
    doc.text("Metais", 95, yPos + 6);
    doc.text("Misses", 115, yPos + 6);
    doc.text("Tempo (s)", 140, yPos + 6);
    doc.text("H.F.", 175, yPos + 6);
    yPos += 8;

    doc.setFont(undefined, 'normal');
    let isZebra = false;
    let totalA = 0, totalC = 0, totalD = 0, totalM = 0, totalMet = 0;

    allRoundsShots.forEach((rodada, i) => {
        if (yPos > 270) { doc.addPage(); yPos = 20; }

        if (isZebra) {
            doc.setFillColor(248, 248, 248);
            doc.rect(15, yPos, 180, 8, 'F');
        }
        isZebra = !isZebra;

        let rA = rodada.filter(s => s.zone === 'A').length;
        let rC = rodada.filter(s => s.zone === 'C').length;
        let rD = rodada.filter(s => s.zone === 'D').length;
        let rM = rodada.filter(s => s.zone === 'M').length;
        let rMet = rodada.filter(s => s.zone === '-').length;

        totalA += rA; totalC += rC; totalD += rD; totalM += rM; totalMet += rMet;

        let tempoRound = parseFloat(timeHistory[i]) || 0;
        let hfRodada = hfHistory[i] || 0;

        doc.setTextColor(50, 50, 50);
        doc.text(`R${i + 1}`, 18, yPos + 6);
        doc.text(`${rA}`, 45, yPos + 6);
        doc.text(`${rC}`, 60, yPos + 6);
        doc.text(`${rD}`, 80, yPos + 6);
        doc.text(`${rMet}`, 100, yPos + 6);
        
        if (rM > 0) doc.setTextColor(220, 53, 69);
        doc.text(`${rM}`, 120, yPos + 6);
        doc.setTextColor(50, 50, 50);

        doc.text(`${tempoRound.toFixed(2)}`, 145, yPos + 6);
        
        doc.setFont(undefined, 'bold');
        doc.setTextColor(25, 118, 210); // Azul Escuro
        doc.text(`${hfRodada.toFixed(2)}`, 175, yPos + 6);
        doc.setFont(undefined, 'normal');

        yPos += 8;
    });

    // ==========================================
    // 4. GRÁFICOS VISUAIS
    // ==========================================
    doc.addPage();
    yPos = 20;
    
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text("Curva de Evolução Visual:", 15, yPos);
    yPos += 10;

    if (typeof myChart !== 'undefined' && myChart !== null) {
        const imgChart = myChart.canvas.toDataURL('image/png', 1.0);
        doc.addImage(imgChart, 'PNG', 15, yPos, 180, 85);
        yPos += 100;
    }

    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.setFont(undefined, 'bold');
    doc.text("Distribuição de Impactos Globais:", 15, yPos);
    yPos += 15;

    let zonasStats = [
        { label: "Alfa", val: totalA, color: [40, 167, 69] },      // Verde
        { label: "Charlie", val: totalC, color: [23, 162, 184] },  // Ciano escuro
        { label: "Delta", val: totalD, color: [255, 193, 7] },     // Amarelo
        { label: "Metal", val: totalMet, color: [108, 117, 125] }, // Cinza
        { label: "Miss", val: totalM, color: [220, 53, 69] }       // Vermelho
    ];

    let maxValor = Math.max(totalA, totalC, totalD, totalMet, totalM, 1);
    let xBarra = 20;
    let alturaMaxBarra = 40;

    zonasStats.forEach(zona => {
        let altura = (zona.val / maxValor) * alturaMaxBarra;

        doc.setFillColor(230, 230, 230);
        doc.rect(xBarra + 1, yPos + alturaMaxBarra - altura + 1, 20, altura, 'F');

        doc.setFillColor(zona.color[0], zona.color[1], zona.color[2]);
        doc.rect(xBarra, yPos + alturaMaxBarra - altura, 20, altura, 'F');

        doc.setFontSize(11);
        doc.setTextColor(50, 50, 50);
        doc.setFont(undefined, 'bold');
        doc.text(zona.val.toString(), xBarra + 10, yPos + alturaMaxBarra - altura - 3, { align: "center" });

        doc.setFont(undefined, 'normal');
        doc.text(zona.label, xBarra + 10, yPos + alturaMaxBarra + 6, { align: "center" });

        xBarra += 32;
    });

    // ==========================================
    // 5. SALVA O DOCUMENTO
    // ==========================================
    doc.save(`Relatório_IPS_Metrix_${atleta.replace(/\s+/g, '_')}.pdf`);
}

async function runAICoach() {
    if (shots.length < 2) return;

    const scoreMode = document.getElementById("scoreModeSel").value;
    const isBestTwo = (scoreMode === "best2");

    let hfAtual = parseFloat(document.getElementById("hf").innerText);
    let validAtual = getValidShots(shots);
    let statsAtual = extractStats(shots);

    let pbHF = hfHistory.length > 0 ? Math.max(...hfHistory) : hfAtual;
    if (hfAtual > pbHF) {
        localStorage.setItem('pb_hf', hfAtual);
        pbHF = hfAtual;
    }

    let feedback = `<div style="display:flex; justify-content:space-between; flex-wrap:wrap; text-align:center; margin-bottom:15px;">`;

    // --- GERAÇÃO DAS CAIXAS DIGITAIS UNIFICADAS ---
    let hfAnt = 0;
    let statsAnt = { avgTrans: 0, avgDT: 0 };

    // O construtor unificado da caixa
    const makeBox = (title, valAtual, valAnt = null, invertGood = false) => {
        let diffHtml = "";
        let color = "#333";
        let suffix = title === "Hit Factor" ? "" : "s";

        if (valAnt !== null) {
            let diff = valAtual - valAnt;
            let sign = diff > 0 ? "+" : "";
            if (diff !== 0) {
                let isBetter = invertGood ? diff < 0 : diff > 0;
                color = isBetter ? "#28a745" : "#dc3545";
            }
            let diffStr = diff === 0 ? "=" : `${sign}${diff.toFixed(2)}`;
            diffHtml = `<div style="font-size:0.75em; color:${color}; font-weight:bold;">Ant: ${valAnt.toFixed(2)}<br>(${diffStr})</div>`;
        } else {
            // Design exclusivo e limpo para a 1ª rodada
            color = "#1976D2";
            diffHtml = `<div style="font-size:0.75em; color:#999; font-weight:bold;">Base<br>Registrada</div>`;
        }

        return `
        <div style="flex: 1 1 30%; min-width: 100px; background: var(--bg-caixas); border-radius:8px; padding:12px 5px; margin:4px; box-shadow:0 2px 4px rgba(0,0,0,0.1); border-bottom: 4px solid ${color}; transition: 0.3s; display: flex; flex-direction: column; justify-content: space-between;">
            <div style="font-size:0.65em; color: var(--texto-sec); font-weight:bold; text-transform:uppercase;">${title}</div>
            <div style="font-size:1.4em; font-weight:900; color: var(--texto-prin); margin:8px 0; word-break: break-word;">${valAtual.toFixed(2)}${suffix}</div>
            ${diffHtml}
        </div>`;
    };

    // Aplica o mesmo design independente de ser a 1ª ou a 10ª rodada
    if (lastRoundShots.length > 0) {
        hfAnt = hfHistory.length > 1 ? hfHistory[hfHistory.length - 2] : 0;
        let validAnt = getValidShots(lastRoundShots);
        statsAnt = extractStats(lastRoundShots);

        feedback += makeBox("Hit Factor", hfAtual, hfAnt, false);
        if (statsAtual.avgTrans > 0 || statsAnt.avgTrans > 0) feedback += makeBox("Transição", statsAtual.avgTrans, statsAnt.avgTrans, true);
        if (isBestTwo && (statsAtual.avgDT > 0 || statsAnt.avgDT > 0)) feedback += makeBox("Cadência", statsAtual.avgDT, statsAnt.avgDT, true);
    } else {
        feedback += makeBox("Hit Factor", hfAtual, null, false);
        if (statsAtual.avgTrans > 0) feedback += makeBox("Transição", statsAtual.avgTrans, null, true);
        if (isBestTwo && statsAtual.avgDT > 0) feedback += makeBox("Cadência", statsAtual.avgDT, null, true);
    }

    feedback += `</div><div style="font-size:0.95em; color: var(--texto-prin); border-top:1px solid var(--borda); padding-top:10px; line-height: 1.5;">`;

    // --- NOVO: DASHBOARD DE PONTOS FORTES E FRAQUEZAS ---
    // Antes estava background:#f1f8e9; e color:#444;
    feedback += `<div style="background: var(--bg-destaque); color: var(--texto-prin); border-radius:8px; padding:10px; margin-bottom:15px; border:1px solid var(--borda); font-size:0.9em; transition: 0.3s;">`;
    let relPB = pbHF > 0 ? ((hfAtual / pbHF) * 100).toFixed(0) : 100;
    feedback += `📈 <b>Evolução vs Recorde:</b> Você operou a <b>${relPB}%</b> do seu melhor nível (${pbHF.toFixed(2)}).<br>`;

    let percAlfa = (validAtual.filter(s => s.zone === 'A' || s.zone === '-').length / validAtual.length) * 100;
    if (percAlfa >= 90) feedback += `✅ <b>Ponto Forte:</b> Precisão excepcional. Foco mantido no centro do alvo.<br>`;

    if (statsAtual.avgTrans > statsAtual.avgDT * 2.5) {
        feedback += `🔍 <b>Gargalo:</b> Suas Transições estão lentas. Tente mover os olhos mais rápido para o próximo alvo.<br>`;
    }
    feedback += `</div>`;

    feedback += `<div style="font-size:0.95em; color: var(--texto-prin); border-top:1px solid var(--borda); padding-top:10px; line-height: 1.5;">`;

    // --- 1. DETECÇÃO CRÍTICA DE PENALIDADES (MISS) ---
    let totalMisses = shots.filter(s => s.zone === 'M').length;
    if (totalMisses > 0) {
        feedback += `❌ <strong style="color:#D32F2F;">FALHA DE EXECUÇÃO:</strong> Penalidade registrada (${totalMisses} Miss). No treino a seco, o Miss indica perda total de alinhamento no momento do acionamento. Requer reavaliação da empunhadura.<br><br>`;
    }

    // --- 2. TELEMETRIA COMPARATIVA DO HIT FACTOR ---
    if (lastRoundShots.length > 0) {
        let hfDiff = hfAtual - hfAnt;
        let transDiff = statsAtual.avgTrans - statsAnt.avgTrans;
        let dtDiff = statsAtual.avgDT - statsAnt.avgDT;

        if (hfDiff > 0) {
            feedback += `🚀 <strong>Evolução Positiva:</strong> Hit Factor ampliado de ${hfAnt.toFixed(2)} para ${hfAtual.toFixed(2)} (+${hfDiff.toFixed(2)}). Fator determinante: `;
            if (transDiff < -0.05 && dtDiff < -0.05) feedback += `Aceleração geral na cadência de disparos mantendo a estabilidade do laser nas zonas Alfa.`;
            else if (transDiff < -0.10) feedback += `Otimização do deslocamento visual (Redução de ${Math.abs(transDiff).toFixed(2)}s nas transições a seco).`;
            else if (dtDiff < -0.05) feedback += `Acionamento do gatilho mais fluído (Redução de ${Math.abs(dtDiff).toFixed(2)}s no Split).`;
            else feedback += `Aumento na precisão dos impactos virtuais sem comprometer o tempo total.`;
            feedback += `<br><br>`;
        } else if (hfDiff < 0) {
            feedback += `⚠️ <strong>Degradação de Desempenho:</strong> Hit Factor reduzido de ${hfAnt.toFixed(2)} para ${hfAtual.toFixed(2)} (${hfDiff.toFixed(2)}). Causa raiz provável: `;
            if (totalMisses > 0) feedback += `Implosão matemática do Fator devido a penalidades (Miss).`;
            else if (transDiff > 0.10) feedback += `Arraste excessivo do equipamento (Aumento de ${transDiff.toFixed(2)}s nas transições).`;
            else if (dtDiff > 0.05) feedback += `Travamento no reset do gatilho ou excesso de confirmação de visada (Splits degradados em ${dtDiff.toFixed(2)}s).`;
            else feedback += `Acionamento agressivo do gatilho gerando instabilidade ("gatilhada"), deslocando o laser para as zonas Charlie/Delta.`;
            feedback += `<br><br>`;
        }
    }

    // --- 3. MICRO-ANÁLISE DE TELEMETRIA A SECO ---
    let worstTrans = { time: 0, from: '', to: '', shotNum: 0 };
    let rushedShots = [];
    let sluggishShots = [];

    for (let i = 1; i < shots.length; i++) {
        let s = shots[i];
        let prev = shots[i - 1];
        let split = s.totalTime - prev.totalTime;
        let shotNum = i + 1;

        if (s.target !== prev.target) {
            if (split > worstTrans.time) worstTrans = { time: split, from: prev.target, to: s.target, shotNum: shotNum };
        } else {
            if (split < 0.25 && (s.zone === 'C' || s.zone === 'D')) rushedShots.push(`Tiro ${shotNum} (Alvo ${s.target})`);
            else if (split > 0.40 && (s.zone === 'A' || s.zone === '-')) sluggishShots.push(`Tiro ${shotNum} (Alvo ${s.target})`);
        }
    }

    let microFeedback = "";
    if (worstTrans.time > 0) {
        microFeedback += `👉 <strong>Gargalo de Transição:</strong> O deslocamento do <strong>Alvo ${worstTrans.from} para o ${worstTrans.to}</strong> demandou ineficientes <strong>${worstTrans.time.toFixed(2)}s</strong>. Conduza a visada com os olhos antes de mover a arma.<br>`;
    }
    if (rushedShots.length > 0) {
        microFeedback += `👉 <strong>Gatilhada Detectada:</strong> No <strong>${rushedShots.join(' e ')}</strong>, o Split foi muito rápido. Em treino a seco, isso indica que você "esmagou" o gatilho, desestabilizando o cano no momento do disparo.<br>`;
    }
    if (sluggishShots.length > 0) {
        microFeedback += `👉 <strong>Excesso de Confirmação:</strong> No <strong>${sluggishShots.join(' e ')}</strong>, ocorreu "Over-confirmation". Você congelou a mira no centro do alvo por mais tempo que o necessário. Confie na sua empunhadura.<br>`;
    }

    if (microFeedback !== "") feedback += `<strong>📋 DIAGNÓSTICO ESTRUTURAL (TREINO A SECO):</strong><br>` + microFeedback;
    feedback += `</div>`;

    // ==========================================================
    // [TELEMETRIA NEURAL TENSORFLOW REMOVIDA PARA OTIMIZAÇÃO E PRESERVAÇÃO DE BATERIA/MEMÓRIA]

    // Agora o código sobrevive para chegar aqui e atualizar a tela!
    document.getElementById("aiFeedback").innerHTML = feedback;
    // ==========================================================
    // 🗣️ PROTOCOLO DE ANÚNCIO E AUTO-START (INTELIGENTE)
    // ==========================================================

    // LÊ O TEMPO EXATO DA TELA NO NOVO FORMATO LIMPO (ex: "4.8" ou "12.5")
    let tempoTela = document.getElementById("chrono").innerText;
    let tempoStr = "";

    // Verifica se o relógio tem minutos (ex: "1:05.2") ou se está só nos segundos (ex: "5.2")
    if (tempoTela.includes(':')) {
        // Se passou de 1 minuto, lê normal
        let partesTempo = tempoTela.split(/[:.]/);
        tempoStr = `${parseInt(partesTempo[0])} minuto, ${parseInt(partesTempo[1])} ponto ${parseInt(partesTempo[2])}`;
    } else {
        // Se for menos de 1 minuto (o padrão), substitui o ponto pela palavra "ponto"
        tempoStr = tempoTela.replace('.', ' ponto ');
    }

    let hfStr = hfAtual.toFixed(2).replace('.', ' ponto ');

    let autoMode = parseInt(document.getElementById("autoModeSel").value);
    if (autoMode > 0) { roundsCount++; }
    let isSequenceEnd = (autoMode > 0 && roundsCount >= autoMode);

    // CÁLCULO CORRETO: Total de tiros - Válidos - Misses
    let totalMissesVoz = shots.filter(s => s.zone === 'M').length;
    let totalExtrasVoz = Math.max(0, shots.length - validAtual.length - totalMissesVoz);

    let finalPoints = parseInt(document.getElementById("score").innerText);
    // 1. CONSTRÓI O RESUMÃO COMPLETO
    let resumao = `Tempo ${tempoStr}. Hit Factor ${hfStr}. ${finalPoints} pontos. `;

    // Adiciona Transição e Cadência na voz (se existirem)
    if (statsAtual.avgTrans > 0) {
        resumao += `Transição média ${statsAtual.avgTrans.toFixed(2).replace('.', ' vírgula ')}. `;
    }
    if (isBestTwo && statsAtual.avgDT > 0) {
        resumao += `Cadência média ${statsAtual.avgDT.toFixed(2).replace('.', ' vírgula ')}. `;
    }

    // Alerta de Miss e Extras (SEM falar a palavra "penalidade" e com IF isolado para não dar erro)
    if (totalMissesVoz > 0) resumao += `${totalMissesVoz} misses. `;

    if (totalExtrasVoz === 1) {
        resumao += `1 extra hit. `;
    } else if (totalExtrasVoz > 1) {
        resumao += `${totalExtrasVoz} extra hits. `;
    }

    // Ponto Forte
    if (validAtual.length > 0) {
        let percAlfaVoz = (validAtual.filter(s => s.zone === 'A' || s.zone === '-').length / validAtual.length) * 100;
        if (percAlfaVoz >= 90) resumao += `Ponto forte: Precisão excelente. `;
    }

    // Evolução vs Rodada Anterior
    if (lastRoundShots.length > 0) {
        let hfAntVoz = hfHistory.length > 1 ? hfHistory[hfHistory.length - 2] : 0;
        let hfDiffVoz = hfAtual - hfAntVoz;
        if (hfDiffVoz > 0.1) resumao += `Evolução detectada. `;
        else if (hfDiffVoz < -0.1) resumao += `Houve queda de rendimento. `;
    }

    // Diagnóstico Tático Micro
    if (worstTrans.time > 0) resumao += `Melhore a transição para o alvo ${worstTrans.to}. `;
    if (rushedShots.length > 0) resumao += `Gatilhada detectada. `;
    else if (sluggishShots.length > 0) resumao += `Excesso de confirmação visual. `;

    let fala = "";

    // 2. DECIDE QUANDO FALAR O RESUMÃO OU O TEXTO CURTO
    if (autoMode === 0) {
        // MANUAL: Fala o resumão completo de diagnóstico
        fala = resumao;
    } else {
        // AUTOMÁTICO
        if (isSequenceEnd) {
            // ÚLTIMA RODADA: Avisa que acabou a bateria e dá o diagnóstico final
            fala = `Rodada ${roundsCount} encerrada. Fim da bateria. Resultado: ` + resumao;
            roundsCount = 0;
            isAutoRunning = false;
        } else {
            // RODADAS INTERMEDIÁRIAS: Fala rápido, mas ALERTA se tomou extra hit ou miss
            fala = `Rodada ${roundsCount}. Tempo ${tempoStr}. Hit Factor ${hfStr}. `;
            if (totalMissesVoz > 0 || totalExtrasVoz > 0) fala += `Atenção aos erros. `;
            lastRoundShots = [...shots];
        }
    }

    let nextRoundCallback = () => {
        if (autoMode > 0 && !isSequenceEnd) {
            prepareStart(true);
        }
    };

    speakCoach(fala, nextRoundCallback);
}
// =========================================
// CONTROLE DE SOM E LUZ
// =========================================

function toggleSom(estado) {
    let valor = estado ? 1 : 0;
    // Usa a rota exclusiva "sound" que já existe no Master
    sendCmd("sound", valor);
    console.log("Comando de SOM enviado: " + valor);
}

function toggleLuz(estado) {
    let valor = estado ? 1 : 0;
    // Usa a rota exclusiva "light" que já existe no Master
    sendCmd("light", valor);
    console.log("Comando de LUZ enviado: " + valor);
}


// ==========================================
// LÓGICA DE SELEÇÃO POR MODAL
// ==========================================
function abrirModal(id) {
    let modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'flex';
    }
}

function fecharModais() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
}
function fecharModal(id) {
    let modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'none';
    }
}
function atualizarInstrucoesCalibracao() {
    let modo = document.getElementById("calibLimitSel").value;
    let textoBox = document.getElementById("texto-calibracao");
    let xAlfa = document.getElementById("svg-x-alfa");
    let xCharlie = document.getElementById("svg-x-charlie");

    if (modo === "1") {
        // MODO 5 DISPAROS (RÁPIDA)
        textoBox.innerHTML = `
            <div style="margin-bottom: 8px;"><b>1.</b> O alvo apagará as referências antigas.</div>
            <div style="margin-bottom: 8px;"><b>2.</b> Efetue exatos <b>5 disparos</b> no <b>CENTRO (Alfa)</b> marcado pelo <span style="color: #E53935; font-weight: 900;">X vermelho</span>.</div>
            <div style="margin-bottom: 8px;"><b>3.</b> O alvo piscará <span style="color: #4da3ff; font-weight: bold;">Azul</span> a cada impacto.</div>
            <div><b>4.</b> No 5º tiro, a calibração finaliza e salva a métrica central.</div>
        `;
        // Oculta o X da borda
        xAlfa.style.display = "block";
        xCharlie.style.display = "none";
    } else {
        // MODO 10 DISPAROS (AVANÇADA)
        textoBox.innerHTML = `
            <div style="margin-bottom: 8px;"><b>1. FASE ALFA:</b> Efetue <b>5 disparos</b> no <b>CENTRO</b> (Marca 1).</div>
            <div style="margin-bottom: 8px;"><b>2. ALERTA:</b> No 5º tiro, o LED <span style="color: #2196F3; font-weight: bold;">Charlie piscará 3x</span> indicando a troca de fase.</div>
            <div style="margin-bottom: 8px;"><b>3. FASE CHARLIE:</b> Efetue mais <b>5 disparos</b> na <b>BORDA</b> (Marca 2).</div>
            <div><b>4.</b> No 10º tiro, as métricas de limite são gravadas.</div>
        `;
        // Mostra os DOIS "X" (Com as bolinhas numeradas 1 e 2)
        xAlfa.style.display = "block";
        xCharlie.style.display = "block";
    }
}
// ==========================================
// LÓGICA DO LIMITE CUSTOMIZADO DE DISPAROS
// ==========================================
function confirmarLimiteCustomizado() {
    let inputEl = document.getElementById('customShotsInput');
    // parseInt força a ser número inteiro, cortando qualquer vírgula ou letra
    let val = parseInt(inputEl.value);

    if (isNaN(val) || val < 1) {
        showToast("⚠️ Digite um número válido maior que zero.");
        return;
    }

    // Trava tática: Máximo absoluto de 100 disparos
    if (val > 100) {
        val = 100;
        inputEl.value = 100;
        showToast("⚠️ Limite ajustado para o máximo permitido (100).");
    }

    // Atualiza o sistema e fecha o modal
    updateSelection('maxShotsSel', val.toString(), val + ' Disparos');
    inputEl.value = ''; // Limpa a caixa para a próxima vez
}

function atualizarVisibilidadeLimiteDisparos() {
    const scoreModeEl = document.getElementById("scoreModeSel");
    const container = document.getElementById("container-max-shots");
    if (scoreModeEl && container) {
        if (scoreModeEl.value === "best2") {
            container.style.display = "none";
        } else {
            container.style.display = "block";
        }
    }
}

function updateSelection(inputId, val, label) {
    const input = document.getElementById(inputId);
    if (input) input.value = val;

    // Tenta encontrar o rótulo da forma antiga ou da forma nova sem crashar
    let labelEl = document.getElementById('label-' + inputId.replace('Sel', '')) || document.getElementById('label-' + inputId);
    if (labelEl) labelEl.innerText = label;

    fecharModais();

    // Dispara gatilhos especiais
    if (inputId === 'targetSel') identificarAlvo();
    if (inputId === 'scoreModeSel') atualizarVisibilidadeLimiteDisparos();
    saveSettings();
}
// ==========================================
// CÉREBRO DAS EXPLICAÇÕES TÁTICAS (TOOLTIPS)
// ==========================================
function abrirModalInfo(topico) {
    let title = "";
    let text = "";

    if (topico === 'hf') {
        title = "O que é Hit Factor?";
        text = "O cálculo do <b>Hit Factor (HF)</b> no IPSC é realizado dividindo o total de pontos obtidos nos alvos (subtraindo penalidades) pelo tempo em segundos decorrido para concluir a pista.<br><br><div style='text-align:center; margin: 15px 0;'><span style='color:var(--primary); font-weight:900; font-size:1.3rem; padding: 10px; border: 1px solid var(--borda); border-radius: 8px; background: rgba(0,0,0,0.2);'>HF = PONTOS ÷ TEMPO</span></div>O objetivo é maximizar a precisão (pontos) e minimizar o tempo, resultando em um maior fator de acerto e melhor desempenho.";
    } else if (topico === 'zonas') {
        title = "Pontuação de Zonas (Minor)";
        text = "O sistema aplica pontuação padrão:<br><br><span style='color:#4CAF50;'><b>Alfa (A) / Metal:</b> 5 pontos</span><br><span style='color:#2196F3;'><b>Charlie (C):</b> 4 pontos</span><br><span style='color:#FFEB3B;'><b>Delta (D):</b> 2 pontos</span><br><span style='color:#E53935;'><b>Miss (M):</b> -10 pontos (Penalidade)</span><br><br>No IPS Metrix, as penalidades corroem matematicamente o Hit Factor.";
    } else if (topico === 'evolucao') {
        title = "Evolução do Hit Factor";
        text = "Este gráfico traça a linha histórica de todas as rodadas da sua sessão atual. É vital para perceber se você está no momento de 'aquecimento', na sua 'zona de performance ideal', ou se já começou a entrar em estado de 'fadiga'.";
    } else if (topico === 'split') {
        title = "O que é o Split?";
        text = "O <b>Split</b> é o tempo (em segundos) entre o disparo atual e o disparo anterior.<br><br>Analisar Splits permite identificar: <br>1. Velocidade de transição entre alvos diferentes.<br>2. Sua cadência ao dar dois tiros no mesmo alvo (Double Tap).";
    } else if (topico === 'radar') {
        title = "Radar de Performance";
        text = "Compara a rodada atual com a anterior em três frentes:<br><br><b>Hit Factor:</b> Avaliação Global.<br><b>Transição:</b> Velocidade para mudar o cano de um alvo para outro.<br><b>Cadência:</b> Velocidade do Double Tap no mesmo alvo.";
    } else if (topico === 'ia') {
        title = "360 AI Analyst";
        text = "A Inteligência Artificial varre os milissegundos da sua telemetria procurando gargalos. Ela detecta:<br><br>• <b>Gatilhadas:</b> Splits rápidos demais seguidos de Charlie/Delta.<br>• <b>Over-confirmation:</b> Tempo excessivo mirando no centro (Alfa).<br>• <b>Arraste:</b> Lentidão em transições específicas.";
    } else if (topico === 'match') {
        title = "Modo Competição (Match)";
        text = "Transforma o seu painel em um controlador de provas oficial.<br><br><b>1. Stages:</b> Defina quantas pistas a competição terá.<br><b>2. Atletas:</b> Digite os nomes separados por vírgula. O sistema chamará um atirador de cada vez.<br><br><b>Vencedor:</b> O ranking final utiliza o <b>Match Hit Factor</b> (Soma de todos os seus pontos válidos dividida pela soma de todos os seus tempos).";
    }

    document.getElementById('modalTitle').innerHTML = title;
    document.getElementById('modalText').innerHTML = text;
    document.getElementById('infoModal').style.display = 'flex';
}

function fecharModalInfo() {
    document.getElementById('infoModal').style.display = 'none';
}
// ==========================================
// RENDERIZADOR DA MATRIZ TÁTICA IPSC (VETORIAL SVG)
// COM INTER-TRAVAMENTO DE ORDENAÇÃO
// ==========================================
function adicionarAlvoNaMatriz(id) {
    const grid = document.getElementById('matriz-alvos-ipsc');
    if (!grid || document.getElementById(`wrapper-tgt-${id}`)) return;

    const htmlNovoAlvo = `
    <div class="ipsc-wrapper anim-slide-up" id="wrapper-tgt-${id}">
        <div class="ipsc-label">ALVO ${id}</div>
        
        <div class="ipsc-tactical-box">
            <div class="target-hole left"></div>
            <div class="target-hole right"></div>
            
            <svg viewBox="0 0 110 140" class="ipsc-svg-target" id="svg-tgt-${id}">
                <polygon id="tgt-${id}-D" class="svg-zone-d" points="36.3,0.4 73.7,0.4 110,46.5 110,93.5 73.7,139.6 36.3,139.6 0,93.5 0,46.5" />
                <polygon id="tgt-${id}-C" class="svg-zone-c" points="36.3,0.4 73.7,0.4 91.6,46.6 91.6,80.9 67.3,110.2 42.7,110.2 18.4,80.9 18.4,46.6" />
                <polygon id="tgt-${id}-A" class="svg-zone-a" points="49.1,6.4 60.9,6.4 73.2,46.0 73.2,67.2 61.0,85.7 49.0,85.7 36.7,67.2 36.7,46.0" />
            </svg>
        </div>
    </div>`;

    // INTER-TRAVAMENTO 1: Inserção segura que não destrói os elementos atuais
    grid.insertAdjacentHTML('beforeend', htmlNovoAlvo);

    // INTER-TRAVAMENTO 2: Aciona o motor de reordenação
    ordenarMatrizIPSC();
}
// ==========================================
// MOTOR DE ORDENAÇÃO NUMÉRICA DOS ALVOS
// ==========================================
function ordenarMatrizIPSC() {
    const grid = document.getElementById('matriz-alvos-ipsc');
    if (!grid) return;

    // Pega todos os alvos que estão atualmente na tela
    const alvos = Array.from(grid.children);

    // Ordena eles baseados no número do ID (ex: extrai o "2" de "wrapper-tgt-2")
    alvos.sort((a, b) => {
        const idA = parseInt(a.id.replace('wrapper-tgt-', ''));
        const idB = parseInt(b.id.replace('wrapper-tgt-', ''));
        return idA - idB; // Força a ordem crescente
    });

    // Devolve os alvos para a tela na ordem blindada
    alvos.forEach(alvo => grid.appendChild(alvo));
}
// ==========================================
// RENDERIZADOR DA MATRIZ TÁTICA (SVG MIL-SPEC)
// Visual Stealth: Sem letras, apenas flashes de luz
// ==========================================
function atualizarMatrizVisual(idStr) {
    const wrapper = document.getElementById(`wrapper-tgt-${idStr}`);
    if (!wrapper) return;

    const isMetal = metallicTargets.has(parseInt(idStr));

    if (isMetal) {
        // VETOR: Réplica exata (Plástico preto em relevo octogonal + Prato branco)
        wrapper.innerHTML = `
            <div class="ipsc-label">ALVO ${idStr} (METAL)</div>
            <div class="ipsc-tactical-box">
                <svg class="ipsc-svg-target" viewBox="0 0 110 140" id="svg-tgt-${idStr}">
                    <polygon points="36.3,0.4 73.7,0.4 110,46.5 110,93.5 73.7,139.6 36.3,139.6 0,93.5 0,46.5" fill="#181818" stroke="#000000" stroke-width="3" />
                    <circle class="svg-zone-m" id="tgt-${idStr}-M" cx="55" cy="70" r="34" />
                </svg>
            </div>
        `;
    } else {
        // VETOR: O Alvo de Papel (Octógono) LIMPO
        wrapper.innerHTML = `
            <div class="ipsc-label">ALVO ${idStr}</div>
            <div class="ipsc-tactical-box">
                <svg class="ipsc-svg-target" viewBox="0 0 110 140" id="svg-tgt-${idStr}">
                    <polygon class="svg-zone-d" id="tgt-${idStr}-D" points="36.3,0.4 73.7,0.4 110,46.5 110,93.5 73.7,139.6 36.3,139.6 0,93.5 0,46.5" />
                    <polygon class="svg-zone-c" id="tgt-${idStr}-C" points="36.3,0.4 73.7,0.4 91.6,46.6 91.6,80.9 67.3,110.2 42.7,110.2 18.4,80.9 18.4,46.6" />
                    <polygon class="svg-zone-a" id="tgt-${idStr}-A" points="49.1,6.4 60.9,6.4 73.2,46.0 73.2,67.2 61.0,85.7 49.0,85.7 36.7,67.2 36.7,46.0" />
                </svg>
            </div>
        `;
    }
}
// ==========================================
// RENDERIZADOR DA MATRIZ TÁTICA IPSC (VETORIAL SVG)
// ==========================================
function adicionarAlvoNaMatriz_old(id) {
    const grid = document.getElementById('matriz-alvos-ipsc');
    if (!grid || document.getElementById(`wrapper-tgt-${id}`)) return;

    grid.innerHTML += `
    <div class="ipsc-wrapper anim-slide-up" id="wrapper-tgt-${id}">
        <div class="ipsc-label">ALVO ${id}</div>
        
        <div class="ipsc-tactical-box">
            <div class="target-hole left"></div>
            <div class="target-hole right"></div>
            
            <svg viewBox="0 0 110 140" class="ipsc-svg-target" id="svg-tgt-${id}">
                <polygon id="tgt-${id}-D" class="svg-zone-d" points="36.3,0.4 73.7,0.4 110,46.5 110,93.5 73.7,139.6 36.3,139.6 0,93.5 0,46.5" />
                <polygon id="tgt-${id}-C" class="svg-zone-c" points="36.3,0.4 73.7,0.4 91.6,46.6 91.6,80.9 67.3,110.2 42.7,110.2 18.4,80.9 18.4,46.6" />
                <polygon id="tgt-${id}-A" class="svg-zone-a" points="49.1,6.4 60.9,6.4 73.2,46.0 73.2,67.2 61.0,85.7 49.0,85.7 36.7,67.2 36.7,46.0" />
            </svg>
        </div>
    </div>`;
}

// ==========================================
// SENSOR DE IMPACTO (SVG FILL FLASH)
// ==========================================
function dispararFlashIPSC(alvoId, zona) {
    let svgBox = document.getElementById(`svg-tgt-${alvoId}`);
    let alpha = document.getElementById(`tgt-${alvoId}-A`);
    let charlie = document.getElementById(`tgt-${alvoId}-C`);
    let delta = document.getElementById(`tgt-${alvoId}-D`);
    let metal = document.getElementById(`tgt-${alvoId}-M`); // Círculo de metal

    if (!svgBox) return;

    // 1. Limpa todas as classes ativas
    svgBox.classList.remove('flash-miss');
    if (alpha) alpha.classList.remove('flash-alpha');
    if (charlie) charlie.classList.remove('flash-charlie');
    if (delta) delta.classList.remove('flash-delta');
    if (metal) metal.classList.remove('flash-metal');

    // 2. Reflow
    void svgBox.offsetWidth;

    // 3. Injeta a cor
    if (zona === '-' && metal) {
        metal.classList.add('flash-metal'); // Acende Cinza
    } else if (zona === 'A' && alpha) {
        alpha.classList.add('flash-alpha');
    } else if (zona === 'C' && charlie) {
        charlie.classList.add('flash-charlie');
    } else if (zona === 'D' && delta) {
        delta.classList.add('flash-delta');
    } else if (zona === 'M') {
        svgBox.classList.add('flash-miss');
    }

    // 4. Apaga
    setTimeout(() => {
        svgBox.classList.remove('flash-miss');
        if (alpha) alpha.classList.remove('flash-alpha');
        if (charlie) charlie.classList.remove('flash-charlie');
        if (delta) delta.classList.remove('flash-delta');
        if (metal) metal.classList.remove('flash-metal');
    }, 300);
}
// ==========================================================
// MOTOR DE RADAR EM TEMPO REAL (NORMALIZAÇÃO MIL-SPEC)
// ==========================================================
function atualizarRadarEmTempoReal() {
    if (!radarChart || shots.length === 0) return;

    const scoreMode = document.getElementById("scoreModeSel").value;
    const isBestTwo = (scoreMode === "best2");

    let hfAtual = parseFloat(document.getElementById("hf").innerText);
    let tempoAtual = shots[shots.length - 1].totalTime;
    let pontosAtual = parseInt(document.getElementById("score").innerText);

    let validAtual = getValidShots(shots);
    let statsAtual = extractStats(shots);

    let labelsRadar = ['Tempo (s)', 'Hit Factor', 'Pontos'];
    let realAtual = [tempoAtual, hfAtual, pontosAtual];
    let realAnt = [0, 0, 0];

    let hfAnt = 0;
    let statsAnt = { avgTrans: 0, avgDT: 0 };

    if (lastRoundShots.length > 0) {
        let tempoAnt = lastRoundShots[lastRoundShots.length - 1].totalTime;
        hfAnt = hfHistory.length > 0 ? hfHistory[hfHistory.length - 1] : 0;
        let pontosAnt = pointsHistory.length > 0 ? pointsHistory[pointsHistory.length - 1] : 0;

        realAnt = [tempoAnt, hfAnt, pontosAnt];
        let validAnt = getValidShots(lastRoundShots);
        statsAnt = extractStats(lastRoundShots);
    }

    let hasTrans = statsAtual.avgTrans > 0 || statsAnt.avgTrans > 0;
    let hasCad = isBestTwo && (statsAtual.avgDT > 0 || statsAnt.avgDT > 0);

    if (hasTrans) {
        labelsRadar.push('Transição (s)');
        realAtual.push(statsAtual.avgTrans || 0);
        realAnt.push(statsAnt.avgTrans || 0);
    }
    if (hasCad) {
        labelsRadar.push('Cadência (s)');
        realAtual.push(statsAtual.avgDT || 0);
        realAnt.push(statsAnt.avgDT || 0);
    }

    let normAtual = [];
    let normAnt = [];

    // MÁGICA: Normaliza todos os dados para uma escala 0-100%
    for (let i = 0; i < realAtual.length; i++) {
        let isLowerBetter = labelsRadar[i].includes('(s)');
        let curr = realAtual[i];
        let ant = realAnt[i];

        if (lastRoundShots.length === 0) {
            // Se for a primeira rodada, ela dita o limite exterior (100%)
            normAtual.push(100);
            normAnt.push(0);
        } else {
            if (isLowerBetter) {
                // TEMPO / CADÊNCIA / TRANSIÇÃO: Quanto Menor, Melhor.
                // Previne divisão por zero
                let c = curr <= 0 ? 0.001 : curr;
                let a = ant <= 0 ? 0.001 : ant;
                let best = Math.min(c, a); // Pega o número mais rápido

                normAtual.push((best / c) * 100);
                normAnt.push((best / a) * 100);
            } else {
                // HIT FACTOR / PONTOS: Quanto Maior, Melhor.
                let best = Math.max(curr, ant); // Pega o número mais alto
                if (best === 0) best = 1; // Fallback matemático

                normAtual.push((curr / best) * 100);
                normAnt.push((ant / best) * 100);
            }
        }
    }

    // Injeta as "Máscaras" visuais (0-100) no gráfico
    radarChart.data.labels = labelsRadar;
    radarChart.data.datasets[0].data = normAtual;
    radarChart.data.datasets[0].realData = realAtual; // Salva o número verdadeiro para o Pop-up (Tooltip)

    if (lastRoundShots.length > 0) {
        radarChart.data.datasets[1].hidden = false;
        radarChart.data.datasets[1].data = normAnt;
        radarChart.data.datasets[1].realData = realAnt;
    } else {
        radarChart.data.datasets[1].hidden = true;
    }

    // TRAVA DE SEGURANÇA VISUAL: Obriga a teia do radar a ter no máximo 100 limites
    if (radarChart.options.scales.r) {
        radarChart.options.scales.r.min = 0;
        radarChart.options.scales.r.max = 100;
    }

    radarChart.update('none');
}
// ==========================================
// SELETOR DINÂMICO DO MODAL DE CALIBRAÇÃO
// ==========================================
function selecionarModoCalibracao(valor, texto) {
    // 1. Atualiza o valor invisível e o texto do botão
    document.getElementById('calibLimitSel').value = valor;
    document.getElementById('label-calibLimitSel').innerText = texto;

    // 2. Esconde APENAS o modal de seleção (mantendo a tela do Alvo gigante aberta)
    document.getElementById('modal-selecao-calib').style.display = 'none';

    // 3. Atualiza os textos e os X vermelhos na tela do Alvo
    if (typeof atualizarInstrucoesCalibracao === "function") {
        atualizarInstrucoesCalibracao();
    }
}

// ==========================================
// MODO COMPRETIÇÃO
// ==========================================

let tempMatchAthletes = [];
function abrirModalCompeticao() {
    // Guard: se uma competição já está ativa, não reabre o modal de configuração
    if (MatchState.isActive) {
        showToast("🏆 Campeonato em andamento! Use 'Sair da Competição' para encerrar.");
        return;
    }

    if (MatchState.athletes && MatchState.athletes.length > 0) {
        tempMatchAthletes = [...MatchState.athletes];
    }

    // Renderiza as listas dinâmicas no modal
    renderAtletasChips();
    renderAlvosConfigGrid();

    // Abre o modal de configuração de match
    abrirModal('modal-competicao');
}

function adicionarAtletaMatch() {
    let input = document.getElementById("inputAthleteName");
    if (!input) return;

    let nome = input.value.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s]/g, '').trim().toUpperCase();
    if (nome.length === 0) return;

    if (tempMatchAthletes.includes(nome)) {
        showToast("⚠️ Competidor já está na lista!");
        return;
    }

    tempMatchAthletes.push(nome);
    input.value = "";
    renderAtletasChips();
    playClickSound();
}

function removerAtletaMatch(nome) {
    tempMatchAthletes = tempMatchAthletes.filter(n => n !== nome);
    renderAtletasChips();
    playClickSound();
}

function renderAtletasChips() {
    let container = document.getElementById("athletes-chips-container");
    if (!container) return;

    container.innerHTML = "";
    tempMatchAthletes.forEach(nome => {
        container.innerHTML += `
            <div class="athlete-chip" style="display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 193, 7, 0.12); border: 2px solid #FFC107; color: var(--texto-prin); font-weight: 900; font-size: 0.85rem; padding: 6px 12px; border-radius: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); animation: slideUp 0.2s ease;">
                <span>${nome}</span>
                <span onclick="removerAtletaMatch('${nome}')" style="cursor: pointer; color: var(--danger); font-size: 1.2rem; font-weight: 900; margin-left: 4px; line-height: 1; transition: 0.2s;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">&times;</span>
            </div>
        `;
    });

    if (tempMatchAthletes.length === 0) {
        container.innerHTML = `<span style="color: var(--texto-sec); font-size: 0.8rem; font-weight: normal; align-self: center;">Nenhum competidor adicionado</span>`;
    }
}

function renderAlvosConfigGrid() {
    let grid = document.getElementById("match-targets-config-grid");
    if (!grid) return;
    grid.innerHTML = "";

    // Captura todos os alvos pareados na Matriz Tática
    let targetWrappers = document.querySelectorAll('.ipsc-wrapper');
    let targetIds = Array.from(targetWrappers).map(el => parseInt(el.id.replace('wrapper-tgt-', ''))).filter(id => !isNaN(id));

    targetIds.sort((a, b) => a - b); // Ordenação crescente

    targetIds.forEach(id => {
        let isMetal = metallicTargets.has(id);
        let btnStyle = isMetal
            ? "background: rgba(158, 158, 158, 0.08); border-color: #9E9E9E; color: #9E9E9E; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);"
            : "background: rgba(76, 175, 80, 0.08); border-color: var(--primary); color: var(--primary); box-shadow: 0 2px 4px rgba(0,0,0,0.05);";
        let text = isMetal ? "⚪ METAL" : "📄 PAPEL";

        grid.innerHTML += `
            <button type="button" onclick="toggleAlvoMatch(${id})" style="display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 10px 14px; border-radius: 10px; border: 2px solid; ${btnStyle} cursor: pointer; font-size: 0.82rem; font-weight: 900; min-width: 90px; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); outline: none;" class="target-config-btn" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'" onmousedown="this.style.transform='scale(0.95)'" onmouseup="this.style.transform='translateY(0)'">
                <span style="font-size: 0.78rem; color: var(--texto-sec); font-weight: bold; text-transform: uppercase;">ALVO ${id}</span>
                <span>${text}</span>
            </button>
        `;
    });

    if (targetIds.length === 0) {
        grid.innerHTML = `<span style="color: var(--texto-sec); font-size: 0.8rem; font-weight: normal; align-self: center;">Nenhum alvo pareado no momento</span>`;
    }
}

function toggleAlvoMatch(id) {
    if (metallicTargets.has(id)) {
        // Vira papel
        metallicTargets.delete(id);
        fetch(`/cmd?target=${id}&cmd=13`).catch(e => { }); // Comando 13 (IPSC)
        atualizarMatrizVisual(id.toString());
    } else {
        // Vira metálico
        metallicTargets.add(id);
        fetch(`/cmd?target=${id}&cmd=12`).catch(e => { }); // Comando 12 (Metálico)
        atualizarMatrizVisual(id.toString());
    }
    renderAlvosConfigGrid();
    showToast(`🎯 Alvo ${id} redefinido com sucesso!`);
    playClickSound();
}

function iniciarCompeticao() {
    let stages = parseInt(document.getElementById('inputMatchStages').value);

    if (isNaN(stages) || stages < 1) return showToast("⚠️ Número de stages inválido!");
    if (tempMatchAthletes.length === 0) return showToast("⚠️ Adicione pelo menos um competidor!");

    // SÊNIOR: Força o travamento e persistência das Regras IPSC para o campeonato (best2)
    document.getElementById("scoreModeSel").value = "best2";
    document.getElementById("label-scoreMode").innerText = "REGRAS IPSC";
    localStorage.setItem('scoreMode', 'best2');

    // Clona e ordena a lista de atletas de forma estável
    let atletasList = [...tempMatchAthletes];
    atletasList.sort((a, b) => a.localeCompare(b));

    MatchState.isActive = true;
    MatchState.totalStages = stages;
    MatchState.currentStage = 1;
    MatchState.athletes = atletasList;
    MatchState.currentAthleteIndex = 0;
    MatchState.stagesData = [];

    // Adiciona classe de design Match Mode
    document.body.classList.add('match-mode-active');

    // 🔄 PERMUTAÇÃO DE RELEVÂNCIA VISUAL (MUDANÇA DE LUGAR CENTRAL)
    // SÊNIOR: Não forçamos o display:none no card-matriz para que ele fique visível em Alvos no mobile e abaixo do painel no desktop!
    document.getElementById('painel-competicao-central').style.setProperty('display', 'block', 'important');

    document.getElementById('btn-sair-match').style.setProperty('display', 'flex', 'important');
    document.getElementById('card-ia').style.setProperty('display', 'none', 'important');
    document.getElementById('hfChartArea').style.setProperty('display', 'none', 'important');

    fecharModais();
    doReset();
    atualizarPainelCompeticao();
    showToast(`🏆 Campeonato Iniciado! Pista livre para: ${MatchState.athletes[0]}`);
}

function sairCompeticaoManual() {
    MatchState.isActive = false;

    // Remove classe de design Match Mode
    document.body.classList.remove('match-mode-active');

    // 🔄 REVERTE O LAYOUT CENTRAL PARA O MODO TREINO LIVRE
    document.getElementById('painel-competicao-central').style.setProperty('display', 'none', 'important');

    document.getElementById('btn-sair-match').style.setProperty('display', 'none', 'important');
    document.getElementById('card-ia').style.removeProperty('display');
    document.getElementById('hfChartArea').style.setProperty('display', 'block', 'important');

    doReset();
    showToast("🚪 Competição encerrada. Retornando ao Treino Livre.");
}

function atualizarPainelCompeticao() {
    if (!MatchState.isActive) return;
    let atletaAtual = MatchState.athletes[MatchState.currentAthleteIndex];
    document.getElementById("match-current-stage").innerText = `S ${MatchState.currentStage} / ${MatchState.totalStages}`;
    document.getElementById("match-current-athlete").innerText = atletaAtual;

    // Atualiza barra de progresso de atletas no stage atual
    const totalAth = MatchState.athletes.length;
    const doneAth  = MatchState.currentAthleteIndex;
    const pct = totalAth > 0 ? Math.round((doneAth / totalAth) * 100) : 0;
    const barEl   = document.getElementById('match-progress-bar');
    const countEl = document.getElementById('match-progress-count');
    const totalEl = document.getElementById('match-progress-total');
    if (barEl)   barEl.style.width   = `${pct}%`;
    if (countEl) countEl.innerText   = doneAth;
    if (totalEl) totalEl.innerText   = totalAth;

    // Renderiza a lista de progresso ao vivo do Squad com classes CSS
    let squadContainer = document.getElementById("match-squad-progress");
    if (squadContainer) {
        let html = '';

        // Fila de atletas
        MatchState.athletes.forEach((atleta, idx) => {
            let rowClass = 'squad-row';
            let statusText = '';
            let hfStr = '';

            if (idx === MatchState.currentAthleteIndex) {
                rowClass += ' squad-row--active';
                statusText = '🔥 VEZ';
            } else if (idx < MatchState.currentAthleteIndex) {
                // Busca o HF já registrado neste stage
                let stageEntry = MatchState.stagesData.find(s => s.athlete === atleta && s.stage === MatchState.currentStage);
                hfStr = stageEntry ? `HF ${stageEntry.hf.toFixed(2)}` : '✅ OK';
                statusText = hfStr;
            } else {
                statusText = '⏳ FILA';
            }

            html += `<div class="${rowClass}">
                <span class="squad-row__name">${atleta}</span>
                <span class="squad-row__status">${statusText}</span>
            </div>`;
        });

        // CLASSIFICAÇÃO GERAL EM TEMPO REAL — com placeholder quando stage 1 ainda não tem dados
        if (MatchState.stagesData && MatchState.stagesData.length > 0) {
            let totaisAtletas = {};
            MatchState.athletes.forEach(a => totaisAtletas[a] = 0);
            MatchState.stagesData.forEach(sd => { totaisAtletas[sd.athlete] += sd.hf; });

            let ranking = Object.keys(totaisAtletas)
                .map(a => ({ nome: a, totalHf: totaisAtletas[a] }))
                .sort((a, b) => b.totalHf - a.totalHf);

            html += `<div style="margin-top:14px; padding-top:12px; border-top:1px dashed rgba(255,193,7,0.2);">
                <div style="font-size:0.68rem; color:#c8d0e0; text-transform:uppercase; letter-spacing:0.5px; font-weight:700; margin-bottom:8px;">🏅 Classificação Parcial</div>
                <div style="display:flex; flex-direction:column; gap:6px;">`;

            ranking.forEach((r, idx) => {
                let medalha = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}º`;
                html += `<div class="squad-row${idx === 0 ? ' squad-row--active' : ''}">
                    <span class="squad-row__name">${medalha} ${r.nome}</span>
                    <span class="squad-row__hf">HF ${r.totalHf.toFixed(2)}</span>
                </div>`;
            });
            html += `</div></div>`;
        } else {
            html += `<div style="margin-top:12px; padding:10px; text-align:center; font-size:0.8rem; color:#c8d0e0; border-top:1px dashed rgba(255,193,7,0.15);">Classificação disponível após o 1º stage</div>`;
        }

        squadContainer.innerHTML = html;
    }
}

function processarStageCompeticao(pts, time, hf) {
    let atletaAtual = MatchState.athletes[MatchState.currentAthleteIndex];

    // Grava a sÚmula eletrônica da rodada
    MatchState.stagesData.push({
        athlete: atletaAtual,
        stage: MatchState.currentStage,
        pts: pts,
        time: time,
        hf: hf,
        rawShots: [...shots]
    });

    // 📋 ALIMENTA O POPUP DO ATLETA (CONFORME SUA PLANILHA DE SÚMULA)
    document.getElementById("res-atleta-nome").innerText = atletaAtual;
    document.getElementById("res-atleta-stage").innerText = `STAGE ${MatchState.currentStage}`;
    document.getElementById("res-atleta-tempo").innerText = time.toFixed(2);
    document.getElementById("res-atleta-pontos").innerText = pts;
    document.getElementById("res-atleta-hf").innerText = hf.toFixed(2);

    // Abre o modal intermediário obrigatoriamente
    abrirModal('modal-resultado-atleta');
}

function prosseguirFilaMatch() {
    fecharModais();

    // Avança o ponteiro do atirador
    MatchState.currentAthleteIndex++;

    // Verifica se fechou a rodada de todos os atletas neste Stage
    if (MatchState.currentAthleteIndex >= MatchState.athletes.length) {
        // MÁGICA DE DEV SÊNIOR: Ao fim do stage para todos os atiradores, 
        // exibe a classificação parcial da pista atual em vez de ir direto e silenciosamente
        mostrarResultadosDoStage(MatchState.currentStage);
    } else {
        // Continua a prova para o próximo atirador no mesmo Stage
        doReset();
        atualizarPainelCompeticao();
        showToast(`🎯 PRÓXIMO ATLETA: ${MatchState.athletes[MatchState.currentAthleteIndex]}`);
    }
}

// ==========================================
// 🏆 CONTROLES DINÂMICOS E TÁTEIS DO MATCH (DESIGNER-APPROVED)
// ==========================================
function alterarStagesCount(delta) {
    let display = document.getElementById("displayMatchStages");
    let input = document.getElementById("inputMatchStages");
    if (!display || !input) return;

    let val = parseInt(input.value) + delta;
    if (val < 1) val = 1;
    if (val > 24) val = 24; // Mantém o limite do HTML original (1 a 24 pistas)

    input.value = val;
    display.innerText = val;
    playClickSound();
}

function mostrarResultadosDoStage(stageNum) {
    // Filtra os dados apenas para o stage atual
    let dadosStage = MatchState.stagesData.filter(s => s.stage === stageNum);

    // Ordena os competidores do stage por Hit Factor (decrescente)
    dadosStage.sort((a, b) => b.hf - a.hf);

    // Configura o título e subtítulo do modal
    document.getElementById("stage-results-title").innerText = `🏆 RESULTADOS - STAGE ${stageNum}`;
    document.getElementById("stage-results-subtitle").innerText = `Classificação oficial da Pista ${stageNum}`;

    // Determina o texto do botão de avanço
    let btnProsseguir = document.getElementById("btn-prosseguir-stage");
    if (stageNum >= MatchState.totalStages) {
        btnProsseguir.innerHTML = "VER CLASSIFICAÇÃO GERAL FINAL 🏆";
        btnProsseguir.style.background = "var(--primary)";
    } else {
        btnProsseguir.innerHTML = `AVANÇAR PARA O STAGE ${stageNum + 1} ➡️`;
        btnProsseguir.style.background = "#FFC107";
        btnProsseguir.style.color = "#111";
    }

    // Constrói a tabela de resultados do Stage concluído com classes de pódio
    const rankClasses = ['leaderboard-row-1st', 'leaderboard-row-2nd', 'leaderboard-row-3rd'];
    let html = `<table class="leaderboard-table">
        <thead>
            <tr>
                <th>RANK</th>
                <th style="text-align:left;">ATLETA</th>
                <th>PONTOS</th>
                <th>TEMPO</th>
                <th>HIT FACTOR</th>
            </tr>
        </thead>
        <tbody>`;

    dadosStage.forEach((res, index) => {
        let medalha = index === 0 ? "🥇 1º" : index === 1 ? "🥈 2º" : index === 2 ? "🥉 3º" : `${index + 1}º`;
        let rowClass = index < 3 ? rankClasses[index] : '';

        html += `<tr class="${rowClass}">
            <td style="font-size:1.1rem; font-weight:bold;">${medalha}</td>
            <td style="text-align:left; font-weight:900;">${res.athlete}</td>
            <td style="font-weight:bold;">${res.pts}</td>
            <td>${res.time.toFixed(2)}s</td>
            <td class="leaderboard-hf">${res.hf.toFixed(2)}</td>
        </tr>`;
    });

    if (dadosStage.length === 0) {
        html += `<tr><td colspan="5" style="padding: 20px; color: var(--texto-sec);">Nenhum dado registrado para este stage.</td></tr>`;
    }

    html += `</tbody></table>`;

    document.getElementById("stage-results-body").innerHTML = html;
    abrirModal('modal-stage-results');

    if (typeof playBeep === 'function') {
        playBeep();
    }
}

function confirmarAvancoStage() {
    fecharModal('modal-stage-results');

    // Reseta o ponteiro de atletas para o próximo stage e incrementa o stage
    MatchState.currentAthleteIndex = 0;
    MatchState.currentStage++;

    // Verifica se encerrou o campeonato inteiro
    if (MatchState.currentStage > MatchState.totalStages) {
        MatchState.isActive = false;

        // Remove classe de design Match Mode
        document.body.classList.remove('match-mode-active');

        // Devolve a interface ao normal
        document.getElementById('painel-competicao-central').style.setProperty('display', 'none', 'important');
        document.getElementById('btn-entrar-match')?.style.setProperty('display', 'flex', 'important');
        document.getElementById('btn-sair-match').style.setProperty('display', 'none', 'important');
        document.getElementById('card-ia').style.removeProperty('display');

        // Dispara a Leaderboard Final com os dados consolidados
        mostrarLeaderboard();
    } else {
        // Continua a prova para o próximo Stage
        doReset();
        atualizarPainelCompeticao();
        showToast(`🎯 INICIANDO STAGE ${MatchState.currentStage}! Atirador: ${MatchState.athletes[MatchState.currentAthleteIndex]}`);
    }
}

// ==========================================
// 🏆 LEADERBOARD RANKING (PONTOS TOTAIS ADICIONADOS)
// ==========================================
function mostrarLeaderboard() {
    let resultados = MatchState.athletes.map(atleta => {
        let meusStages = MatchState.stagesData.filter(s => s.athlete === atleta);

        // SÊNIOR: Soma matemática real de todos os estágios do campeonato
        let totalPts = meusStages.reduce((acc, curr) => acc + curr.pts, 0);
        let totalTime = meusStages.reduce((acc, curr) => acc + curr.time, 0);

        let overallHF = (totalTime > 0 && totalPts > 0) ? (totalPts / totalTime) : 0;

        return { nome: atleta, pts: totalPts, time: totalTime, hf: overallHF };
    });

    resultados.sort((a, b) => b.hf - a.hf);

    // MÁGICA DE DEV SÊNIOR: Define o primeiro colocado como 100.00% e os demais proporcionais a ele
    let maxHF = resultados.length > 0 ? resultados[0].hf : 0;

    // Layout de tabela com classes CSS de pódio
    const rankClasses = ['leaderboard-row-1st', 'leaderboard-row-2nd', 'leaderboard-row-3rd'];
    let html = `<table class="leaderboard-table">
        <thead>
            <tr>
                <th>RANK</th>
                <th style="text-align:left;">ATLETA</th>
                <th>PONTOS TOTAIS</th>
                <th>CAMPEONATO H.F. (%)</th>
                <th>SÚMULAS</th>
            </tr>
        </thead>
        <tbody>`;

    resultados.forEach((res, index) => {
        let medalha = index === 0 ? "🥇 1º" : index === 1 ? "🥈 2º" : index === 2 ? "🥉 3º" : `${index + 1}º`;
        let rowClass = index < 3 ? rankClasses[index] : '';

        let pctStr = "0.00%";
        if (maxHF > 0) {
            pctStr = ((res.hf / maxHF) * 100).toFixed(2) + "%";
        }

        let botoesStages = `<button onclick="abrirSumula('${res.nome}', 1)" 
            style="background: transparent; border: 1px solid rgba(255,193,7,0.4); color: #FFC107; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-weight: 800; font-size: 0.82rem; transition: all 0.2s; letter-spacing: 0.3px;" onmouseover="this.style.background='rgba(255,193,7,0.1)'" onmouseout="this.style.background='transparent'">
            📄 SÚMULAS
        </button>`;

        html += `<tr class="${rowClass}">
            <td style="font-size:1.1rem;">${medalha}</td>
            <td style="text-align:left; font-weight:900;">${res.nome}</td>
            <td style="font-weight:bold;">${res.pts}</td>
            <td class="leaderboard-hf">${pctStr}</td>
            <td style="padding: 5px;">
                <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 2px;">
                    ${botoesStages}
                </div>
            </td>
        </tr>`;
    });

    html += `</tbody></table>`;

    document.getElementById("leaderboard-body").innerHTML = html;
    abrirModal('modal-leaderboard');

    if (typeof playBeep === 'function') {
        playBeep();
        setTimeout(playBeep, 400);
    }
}

// ==========================================
// 🏆 DETALHAMENTO DE SÚMULA POR STAGE DO ATLETA
// ==========================================
// ==========================================
// 🏆 DETALHAMENTO DE SÚMULA POR STAGE DO ATLETA (COM SELETOR INTEGRADO)
// ==========================================
let activeSumulaAthlete = ""; // Armazena o atleta visualizado na súmula

function abrirSumula(athleteName, stageNum = 1) {
    activeSumulaAthlete = athleteName;

    // 1. Povoa o Seletor de Stages com opções de 1 até MatchState.totalStages
    let selector = document.getElementById("sumula-stage-selector");
    if (selector) {
        selector.innerHTML = "";
        for (let i = 1; i <= MatchState.totalStages; i++) {
            selector.innerHTML += `<option value="${i}">STAGE ${i}</option>`;
        }
        selector.value = stageNum;
    }

    // 2. Renderiza os dados do stage selecionado
    renderizarDadosSumulaStage(athleteName, parseInt(stageNum));

    // 3. Abre o modal
    abrirModal('modal-sumula');
}

function alterarStageSumulaExibida() {
    let selector = document.getElementById("sumula-stage-selector");
    if (!selector || !activeSumulaAthlete) return;

    renderizarDadosSumulaStage(activeSumulaAthlete, parseInt(selector.value));
    playClickSound();
}

function renderizarDadosSumulaStage(athleteName, stageNum) {
    const stageData = MatchState.stagesData.find(s => s.athlete === athleteName && s.stage === stageNum);

    // Configura o título
    document.getElementById("sumula-titulo").innerText = `SÚMULA - ${athleteName.toUpperCase()}`;

    const resumo = document.getElementById("sumula-resumo");
    const sumulaBody = document.getElementById("sumula-body");

    if (!stageData) {
        // Se não houver dados gravados (stage ainda não disputado), exibe estado limpo
        resumo.innerHTML = `
            <span style="color: var(--texto-sec);">⏱️ 0.00s</span>
            <span style="color: var(--texto-sec);">🎯 0 Pts</span>
            <span style="color: var(--texto-sec);">HF: 0.00</span>
        `;
        sumulaBody.innerHTML = `<tr><td colspan="4" style="color: var(--texto-sec); padding: 25px; font-weight: normal; font-size: 0.95rem;">Nenhum disparo registrado para esta pista.</td></tr>`;
        return;
    }

    // Atualiza o resumo
    resumo.innerHTML = `
        <span style="color: #2196F3;">⏱️ ${stageData.time.toFixed(2)}s</span>
        <span style="color: #FFC107;">🎯 ${stageData.pts} Pts</span>
        <span style="color: #4CAF50;">HF: ${stageData.hf.toFixed(2)}</span>
    `;

    // Agrupa e calcula quais disparos pontuaram (regras IPSC: best 2 por papel, 1 por metal)
    const rawShots = stageData.rawShots || [];
    let targetGroups = {};
    rawShots.forEach((s, index) => {
        if (!targetGroups[s.target]) targetGroups[s.target] = [];
        targetGroups[s.target].push({
            index: index,
            points: IPSC_ZONES[s.zone] !== undefined ? IPSC_ZONES[s.zone] : 0,
            zone: s.zone
        });
    });

    let countedIndices = new Set();
    for (let tId in targetGroups) {
        let sortedShots = [...targetGroups[tId]].sort((a, b) => b.points - a.points);
        let limit = metallicTargets.has(parseInt(tId)) ? 1 : 2;
        sortedShots.slice(0, limit).forEach(shotObj => {
            countedIndices.add(shotObj.index);
        });
    }

    sumulaBody.innerHTML = "";

    let htmlRows = [];
    rawShots.forEach((s, i) => {
        let split = (i === 0) ? s.totalTime : (s.totalTime - rawShots[i - 1].totalTime);
        let isCounted = countedIndices.has(i);
        let zoneDisplay = s.zone;
        let statusIcon = isCounted ? "✅" : "❌";
        let rowStyle = "";
        let valZonaClass = `color-${s.zone}`;

        if (s.zone === 'M') {
            zoneDisplay = `<span style="color:#D32F2F; font-weight:900;">MISS</span>`;
            rowStyle = "background-color: var(--bg-alerta);";
            valZonaClass = "";
            statusIcon = "❌";
        } else if (s.zone === '-') {
            zoneDisplay = `<span style="color:#9E9E9E; font-weight:900;">M</span>`;
            valZonaClass = "";
        }

        // Se o tiro não contou (tiro extra)
        if (!isCounted && s.zone !== 'M') {
            rowStyle += " text-decoration: line-through; color: #D32F2F; opacity: 0.7;";
            zoneDisplay += ` <span style="font-size: 0.8rem; color: #E53935; display: inline-block; text-decoration: none;">❌</span>`;
        }

        htmlRows.push(`
            <tr style="${rowStyle}">
                <td style="font-size: 0.9em; padding: 12px 8px;">#${i + 1} ${s.target !== '-' ? '(Alvo ' + s.target + ')' : ''}</td>
                <td class="${valZonaClass}" style="padding: 12px 8px;">
                    ${zoneDisplay} ${statusIcon}
                </td>
                <td style="padding: 12px 8px;">${split.toFixed(2)}s</td>
                <td style="padding: 12px 8px;">${s.totalTime.toFixed(2)}s</td>
            </tr>
        `);
    });

    if (htmlRows.length === 0) {
        sumulaBody.innerHTML = `<tr><td colspan="4" style="color: var(--texto-sec); padding: 20px;">Nenhum disparo registrado</td></tr>`;
    } else {
        sumulaBody.innerHTML = htmlRows.join('');
    }

    abrirModal('modal-sumula');
}

// ==========================================
// 🛡️ PROTEÇÃO: SANITIZAÇÃO DE INPUTS (SÊNIOR)
// ==========================================
function sanitizarNome(input) {
    if (!input) return;
    let original = input.value;
    // Permite apenas letras (incluindo acentuadas latinas) e espaços
    let sanitizado = original.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s]/g, '');

    if (original !== sanitizado) {
        input.value = sanitizado;
    }
}

// ==========================================
// 🔊 EFEITOS SONOROS PREMIUM (SÊNIOR)
// ==========================================
function playClickSound() {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    // Frequência rápida senoidal de 1200Hz para um "click" muito agradável e sutil (não-intrusivo)
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);

    gain.gain.setValueAtTime(0.015, now); // Super baixo, não incomoda
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03); // Corta em 30ms

    osc.start(now);
    osc.stop(now + 0.03);
}

// ==========================================
// 📱 BOTTOM NAVIGATION E ABAS (APP-LIKE)
// ==========================================
function switchTab(tabId, btnElement) {
    playClickSound();

    // Remove as classes de tab anteriores
    document.body.classList.remove('tab-controle', 'tab-match', 'tab-alvos', 'tab-analise', 'tab-ajustes');

    // Adiciona a nova classe de tab ao body (isso engatilha o CSS que mostra os cards correspondentes)
    document.body.classList.add(tabId);

    // Remove classe active de todos os botões da barra (inferior e superior)
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(btn => btn.classList.remove('active'));

    // Marca todos os botões correspondentes à aba atual como ativos (sincroniza mobile <-> desktop)
    const activeBtns = document.querySelectorAll(`.nav-item[onclick*="${tabId}"]`);
    activeBtns.forEach(btn => btn.classList.add('active'));

    // Se for a aba Match, abre o modal de competição automaticamente
    if (tabId === 'tab-match') {
        abrirModalCompeticao();
    }
}