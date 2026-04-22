let running = false;
let startTime = 0;
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

// Função para mover a agulha com o Hit Factor
function atualizarGaugeIPSC(hf) {
    if(typeof gaugeChartIPSC !== 'undefined' && gaugeChartIPSC) {
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
let gaugeChartIPSC = null; // <--- ISTO AQUI ERA O QUE ESTAVA A CRASHAR TUDO! Faltava declarar.
let audioCtx = null;
try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
} catch(e) { 
    console.warn("Motor de áudio bloqueado inicialmente."); 
}let metallicTargets = new Set(); // Id alvos metalicos

// ==========================================
// 🛡️ PROTEÇÃO: MANTER TELA ACESA (WAKE LOCK)
// ==========================================
let wakeLock = null;

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('💡 Wake Lock ativado: A tela não vai mais apagar!');
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
        
        msg.onend = triggerCallback;
        msg.onerror = triggerCallback; // Se a voz der erro, inicia a próxima rodada mesmo assim
        
        window.speechSynthesis.speak(msg);
        
        // SEGURO DE FLUXO: Se em 8 segundos a IA não terminar, força o início
        setTimeout(triggerCallback, 8000);
    } else {
        triggerCallback();
    }
}

// --- REDE NEURAL (TensorFlow.js) ---
let tfModel;
async function initTF() {
    tfModel = tf.sequential();
    // Camada de entrada (Recebe: Valor da Zona, É transição? (0 ou 1))
    tfModel.add(tf.layers.dense({units: 8, activation: 'relu', inputShape: [2]}));
    tfModel.add(tf.layers.dense({units: 4, activation: 'relu'}));
    // Camada de saída (Tenta prever o Tempo exato do Split)
    tfModel.add(tf.layers.dense({units: 1})); 
    
    tfModel.compile({optimizer: 'adam', loss: 'meanSquaredError'});
    console.log("🧠 TensorFlow Neural Network Ativada!");
}
// Inicia a rede neural quando a página carrega
window.addEventListener('load', initTF);

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
window.onload = () => {
  // AVISO TÁTICO: NUNCA coloque doReset() aqui no topo! 

 // 1. Restaura Configurações Salvas (Preferências do Atleta)
  try {
    // Limite de Disparos
    const valMaxShots = localStorage.getItem('maxShots');
    if(valMaxShots) {
        document.getElementById("maxShotsSel").value = valMaxShots;
        document.getElementById("label-maxShots").innerText = valMaxShots === '999' ? 'Irrestrito' : valMaxShots + ' Disparos';
    }

    // Modo Automático
    const valAutoMode = localStorage.getItem('autoMode');
    if(valAutoMode) {
        document.getElementById("autoModeSel").value = valAutoMode;
        let lbl = "Manual (Uma vez)";
        if(valAutoMode === '3') lbl = "Auto (3 Rodadas)";
        if(valAutoMode === '5') lbl = "Auto (5 Rodadas)";
        if(valAutoMode === '10') lbl = "Auto (10 Rodadas)";
        document.getElementById("label-autoMode").innerText = lbl;
    }

    // Modo de Pontuação (IPSC vs Ilimitado)
    const valScoreMode = localStorage.getItem('scoreMode');
    if(valScoreMode) {
        document.getElementById("scoreModeSel").value = valScoreMode;
        document.getElementById("label-scoreMode").innerText = valScoreMode === 'best2' ? 'REGRAS IPSC' : 'ILIMITADO';
    }

    // Tipo de Laser
    const valLaser = localStorage.getItem('laserType');
    if(valLaser) {
        document.getElementById("laserType").value = valLaser;
        document.getElementById("label-laserType").innerText = valLaser === '7' ? 'Laser Vermelho' : 'Infravermelho (IR)';
    }

    // Alvo Selecionado
    const valTarget = localStorage.getItem('targetSel');
    if(valTarget) {
        document.getElementById("targetSel").value = valTarget;
        document.getElementById("label-targetSel").innerText = valTarget === '255' ? 'Todos os Alvos' : 'Alvo ' + valTarget;
    }

    // Nome e Voz
    if(localStorage.getItem('athleteName')) document.getElementById("athleteName").value = localStorage.getItem('athleteName');
    if(localStorage.getItem('voiceState') !== null) document.getElementById("voiceToggle").checked = (localStorage.getItem('voiceState') === 'true');
  } catch(e) { console.warn("Aviso nas configurações:", e); }
    
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
                ticks: { color: '#888' } 
            },
            x: { ticks: { color: '#888' } }
        },
        plugins: {
            legend: { display: false } // <-- APAGA O RETÂNGULO VERMELHO
        },
        onClick: (event, elements) => {
             if (elements.length > 0) loadRoundFromHistory(elements[0].index);
        }
      }
    });
  } catch(e) { console.error("Erro no Gráfico de Linha:", e); }

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
                    font: { size: 13, weight: '900', family: 'system-ui, sans-serif' } 
                },
                ticks: { display: false } 
            }
        },
        plugins: { 
            legend: { position: 'top', labels: { color: 'var(--texto-sec)' } },
            // MÁGICA: Engana o gráfico para mostrar o valor real em vez da percentagem
            tooltip: {
                callbacks: {
                    label: function(context) {
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
  } catch(e) { console.error("Erro no Gráfico de Radar:", e); }

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
  } catch(e) { console.error("Erro no Gráfico Gauge:", e); }

  // 5. AGORA SIM! Com os gráficos já criados com segurança, damos o Reset.
  try { doReset(); } catch(e) { console.error("Erro no doReset:", e); }

  // 6. Restaura o Dark Mode
  try {
      if(localStorage.getItem('darkModeState') === 'true') {
          document.getElementById("darkModeToggle").checked = true;
          document.body.classList.add("dark-mode");
      }
  } catch(e) { console.warn("Erro no Dark Mode:", e); }
};

function sendCmd(cmd, val) {
  let tgt = document.getElementById("targetSel").value;
  fetch(`/cmd?target=${tgt}&${cmd}=${val}`).catch(e => {});
}

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
  let currentMax = parseInt(document.getElementById("maxShotsSel").value);
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
    
    // 6. Envia comando para o ESP32
    sendCmd("detect", 1);
    
    // 7. Restaura o botão
    btn.disabled = false;
    btn.innerText = "START";
    console.log("Iniciado - Rodada: " + (roundsCount + 1));
  }, (3000 + Math.random() * 2000) + autoDelay);
}

function renderTable() {
    let h = "";
    let lastT = 0;
    let lZ = "-";
    // Define que o traço (-) vale 5 pontos (Metálico) e Miss -10
    const zonePts = { 'A': 5, 'C': 4, 'D': 2, 'M': -10, '-': 5 };
    const zoneRank = { 'A': 4, 'C': 3, 'D': 2, '-': 1, 'M': -1 };
    
    const scoreMode = document.getElementById("scoreModeSel").value;
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
            points: zonePts[s.zone], 
            zone: s.zone
        });
        if(s.zone !== 'M') lastT = s.totalTime;
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
        
        // B. NOVO: Pega os excedentes e subtrai 10 pontos de cada
        sortedShots.slice(limit).forEach(shotObj => {
            
        });
    }

    // 3. Renderização Visual com Setas
    let accPointsForHF = 0;
        shots.forEach((s, i) => {
            let split = 0;
        if (i === 0) {
            split = s.totalTime;
        } else {
            // Volta ao cálculo original: Tiro Atual - Tiro Anterior
            split = (s.totalTime - shots[i - 1].totalTime);
        }

        let isCounted = countedIndices.has(i);
        
        // NOVO: Cálculo do HF momento a momento com as penalidades
        if (isCounted) {
            accPointsForHF += zonePts[s.zone];
        } else {
            accPointsForHF -= 10; // Subtrai 10 pontos no acumulado do Hit Factor
        }
        
        // Evita mostrar um Hit Factor negativo (trava no zero se os pontos estiverem negativos)
        let pontosValidosHF = accPointsForHF < 0 ? 0 : accPointsForHF;
        let hfMomentaneo = s.totalTime > 0 ? (pontosValidosHF / s.totalTime).toFixed(2) : "0.00";

        let sAnterior = (lastRoundShots && lastRoundShots[i]) ? lastRoundShots[i] : null;
        let splitAnterior = null;
        let hfAnterior = null;
        let zonaAnteriorRank = null;

        if (sAnterior) {
            splitAnterior = (i === 0) ? sAnterior.totalTime : (sAnterior.totalTime - lastRoundShots[i-1].totalTime);
            zonaAnteriorRank = zoneRank[sAnterior.zone];
            
            let pontosAnteriorAteAqui = 0;
            for(let j=0; j<=i; j++) {
                let zAnt = lastRoundShots[j].zone;
                let pAnt = zonePts[zAnt] !== undefined ? zonePts[zAnt] : 0;
                pontosAnteriorAteAqui += pAnt;
            }
            pontosAnteriorAteAqui = pontosAnteriorAteAqui < 0 ? 0 : pontosAnteriorAteAqui;
            hfAnterior = sAnterior.totalTime > 0 ? (pontosAnteriorAteAqui / sAnterior.totalTime).toFixed(2) : "0.00";
        }

        let setaZona = sAnterior ? getSeta(zoneRank[s.zone], zonaAnteriorRank, false) : "";
        let setaSplit = sAnterior ? getSeta(split, splitAnterior, true) : ""; 
        let setaHF = sAnterior ? getSeta(parseFloat(hfMomentaneo), parseFloat(hfAnterior), false) : "";
        let zoneDisplay = s.zone;
        let rowStyle = "";
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
             rowStyle += " text-decoration: line-through; color: #D32F2F; opacity: 0.7;";
             zoneDisplay += ` <span style="font-size: 0.8rem; color: #E53935; display: inline-block; text-decoration: none;">❌</span>`; 
        }

        let statusIcon = isCounted ? "✅" : "❌";
        h += `<tr style="${rowStyle}">
            <td style="font-size: 0.9em;">#${i + 1} ${s.target !== '-' ? '(Alvo '+s.target+')' : ''}</td>
            <td class="${valZonaClass}">
                ${zoneDisplay} ${statusIcon} ${setaZona}
            </td>
            <td>${split.toFixed(2)}s ${setaSplit}</td>
            <td>${hfMomentaneo} ${setaHF}</td> 
          </tr>`;
    });

    // 4. Atualiza DOM Final
    document.getElementById("shotsBody").innerHTML = h;
    document.getElementById("score").innerText = bestPoints;
    let finalHF = lastT > 0 ? (bestPoints / lastT).toFixed(2) : "0.00";
    if (bestPoints < 0 && lastT > 0) finalHF = "0.00";
    
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
        document.getElementById("bA").style.height = ((cA / total) * 100) + "%";
        document.getElementById("bC").style.height = ((cC / total) * 100) + "%";
        document.getElementById("bD").style.height = ((cD / total) * 100) + "%";
        document.getElementById("bM").style.height = ((cM / total) * 100) + "%";
        document.getElementById("bE").style.height = ((cExtra / total) * 100) + "%";
        document.getElementById("bX").style.height = ((cMetal / total) * 100) + "%";
    }
}

function doStop() {
  if (!running) return; 
  running = false; 
  sendCmd("detect", 0);
  playBeep();
  
  // >>> LÓGICA NOVA: VERIFICA TIROS FALTANTES (MISS) <<<
  const maxShots = parseInt(document.getElementById("maxShotsSel").value);
  const scoreMode = document.getElementById("scoreModeSel").value;
  let validos = countValidShots(); 

  // Se for modo IPSC, NÃO for ilimitado e os válidos forem menos que o programado
  if (scoreMode === 'best2' && maxShots !== 999 && validos < maxShots) {
      const missingCount = maxShots - validos;
      const lastShotTime = shots.length > 0 ? shots[shots.length-1].totalTime : 0;
      
      console.log(`Parada manual! Gerando ${missingCount} MISS.`);
      for(let i = 0; i < missingCount; i++) {
          shots.push({
              zone: 'M',
              totalTime: lastShotTime, // Mantém o tempo do último tiro real
              target: '-', // Alvo indefinido
              generated: true // Flag interna se precisar
          });
      }
      // Renderiza novamente para mostrar os MISS e atualizar a pontuação (-10)
      renderTable();
  }
  // -----------------------------------------------------

  if (shots.length > 0) {
    let finalHF = parseFloat(document.getElementById("hf").innerText);
    let finalPoints = parseInt(document.getElementById("score").innerText);
    let finalTime = shots[shots.length - 1].totalTime.toFixed(2);
    
    // EXCLUSÃO DA RODADA MAIS VELHA 
    if (hfHistory.length >= 99) {
      hfHistory.shift();      // Apaga a Rodada 1 do Hit Factor
      timeHistory.shift();    // Apaga a Rodada 1 do Tempo
      pointsHistory.shift();  // Apaga a Rodada 1 dos Pontos
      sessionLabels.shift();  // Apaga o rótulo "R1"
      allRoundsShots.shift(); // Apaga os tiros da memória RAM
    }

    allRoundsShots.push([...shots]);
    hfHistory.push(finalHF);
    timeHistory.push(finalTime);
    pointsHistory.push(finalPoints);
    runAICoach().catch(e => console.log(e));
    
    let nextRoundNum = sessionLabels.length > 0 ? parseInt(sessionLabels[sessionLabels.length-1].replace("R","")) + 1 : 1;
    sessionLabels.push("R" + nextRoundNum);
    document.getElementById("hfChartArea").style.display = "block";
    
    if (myChart) {
      // O SEGREDO DO ANTI-TRAVAMENTO: 
      // O 'none' obriga o gráfico a atualizar instantaneamente sem animações pesadas
      myChart.update('none'); 
    }
  }

 
}

function showToast(msg) {
    let x = document.getElementById("toast");
    if(!x) return;
    x.innerText = msg;
    x.style.visibility = "visible";
    x.style.opacity = "1";
    setTimeout(function(){ x.style.visibility = "hidden"; x.style.opacity = "0"; }, 3500);
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
  
  // 2. Limpa o armazenamento do recorde pessoal
  localStorage.removeItem('pb_hf'); 
  
  // 3. Reset Visual da Tabela e Textos Principais
  document.getElementById("shotsBody").innerHTML = "";
  document.getElementById("hf").innerText = "0.00";
  document.getElementById("score").innerText = "0";
  document.getElementById("chrono").innerText = "0:00.00";
  document.getElementById("lastZone").innerText = "-";
  document.getElementById("lastZone").className = "giant-zone";
  document.getElementById("lastZone").style.color = "";
  
  // 4. Reset do Gráfico de Barras (Zera visualmente)
  const barras = ['A', 'C', 'D', 'X', 'M', 'E'];
  barras.forEach(v => {
      let valEl = document.getElementById("v" + v);
      let barEl = document.getElementById("b" + v);
      if(valEl) valEl.innerText = "0";
      if(barEl) barEl.style.height = "0%";
  });
  
  // 5. Reset do Gráfico de Linha (Evolução)
  if(myChart) {
    myChart.data.datasets[0].data.length = 0; 
    myChart.data.labels.length = 0;           
    myChart.update('none');
  }
  
  // 6. Reset do Gráfico de Radar
  if(radarChart) {
    radarChart.data.datasets[0].data = [0,0,0];
    radarChart.data.datasets[1].data = [0,0,0];
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
}

function fecharModalCalibracao() {
    document.getElementById('modal-calibracao').style.display = 'none';
}

function confirmarCalibracao() {
    fecharModalCalibracao(); // Fecha a janela primeiro
    let laserMode = document.getElementById("laserType").value;
    let tgt = document.getElementById("targetSel").value;
    
    fetch(`/cmd?target=${tgt}&calib=1&laserMode=${laserMode}`)
      .then(() => showToast("✨ Calibração iniciada! Siga o protocolo luminoso nos alvos."))
      .catch(e => showToast("❌ Erro de comunicação ao tentar calibrar."));
}
function doMetalico() {
  let tgt = parseInt(document.getElementById("targetSel").value);
  sendCmd("cmd", 12);
  
  if (tgt === 255) {
     // Aplica em todos os alvos pareados na tela
     document.querySelectorAll('.ipsc-wrapper').forEach(el => {
         let idStr = el.id.replace('wrapper-tgt-', '');
         metallicTargets.add(parseInt(idStr));
         atualizarMatrizVisual(idStr); // REDESENHA PARA O CÍRCULO METÁLICO
     });
     showToast("🎯 Todos os alvos definidos como METÁLICO!");
  } else {
     // Aplica apenas no alvo selecionado
     metallicTargets.add(tgt); 
     atualizarMatrizVisual(tgt.toString()); // REDESENHA PARA O CÍRCULO METÁLICO
     showToast(`🎯 Alvo ${tgt} definido como METÁLICO!`);
  }
}

function doIPSC() {
  let tgt = parseInt(document.getElementById("targetSel").value);
  sendCmd("cmd", 13);
  
  if (tgt === 255) {
      // Limpa a memória metálica e volta tudo para Papel
      metallicTargets.clear();
      document.querySelectorAll('.ipsc-wrapper').forEach(el => {
          let idStr = el.id.replace('wrapper-tgt-', '');
          atualizarMatrizVisual(idStr); // REDESENHA PARA O OCTÓGONO DE PAPEL
      });
      showToast("🎯 Todos os alvos definidos como PAPEL (IPSC)!");
  } else {
      // Volta apenas o alvo selecionado para Papel
      if (metallicTargets.has(tgt)) {
          metallicTargets.delete(tgt);
          atualizarMatrizVisual(tgt.toString()); // REDESENHA PARA O OCTÓGONO DE PAPEL
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

    ws.onopen = () => {
        console.log("🟢 Conectado!");
        showToast("✅ Metrix Online!");
        document.body.style.border = "none"; 
        document.body.style.boxShadow = "none";
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
  let j = JSON.parse(e.data);
  
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
      
      if (shots.length > 0 && splitReal < 0.100) return; // Corta fantasmas
      
      if (metallicTargets.has(j.target)) {
          playMetalSound();
          j.zone = '-';
      }
      
      let max = parseInt(document.getElementById("maxShotsSel").value);
      let mode = document.getElementById("scoreModeSel").value;
      let currentValid = (mode === 'best2') ? countValidShots() : shots.length;

     if (max === 999 || currentValid < max) {
        shots.push({ 
          zone: j.zone, 
          totalTime: (Date.now() - startTime) / 1000,
          target: j.target,
        });
        
        dispararFlashIPSC(j.target, j.zone); 
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

setInterval(() => {
  if (!running) return;
  let seconds = (Date.now() - startTime) / 1000;
  let m = Math.floor(seconds / 60);
  let s = (seconds % 60).toFixed(2).padStart(5, '0');
  document.getElementById("chrono").innerText = m + ":" + s;
}, 50);

function toggleSend(type, isChecked) { sendCmd(type, isChecked ? 1 : 0); }

function getInd(cur, prev, lowerIsBetter) {
  if (prev === null || cur === prev) return "—";
  if (lowerIsBetter) {
    return cur < prev ? '<span style="color:green">▲</span>' : '<span style="color:red">▼</span>';
  }
  return cur > prev ? '<span style="color:green">▲</span>' : '<span style="color:red">▼</span>';
}

function saveSettings() {
  localStorage.setItem('maxShots', document.getElementById("maxShotsSel").value);
  localStorage.setItem('autoMode', document.getElementById("autoModeSel").value);
  localStorage.setItem('scoreMode', document.getElementById("scoreModeSel").value);
  localStorage.setItem('laserType', document.getElementById("laserType").value);
  localStorage.setItem('athleteName', document.getElementById("athleteName").value);
  localStorage.setItem('targetSel', document.getElementById("targetSel").value);
  localStorage.setItem('voiceState', document.getElementById("voiceToggle").checked);
  
  // Salva estado dos checkboxes
  localStorage.setItem('soundState', document.getElementById("soundToggle").checked);
  localStorage.setItem('lightState', document.getElementById("lightToggle").checked);
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

function handleNewShot(newShotData) {
    if (!running) return;

    shots.push(newShotData);
    renderTable();

    const scoreMode = document.getElementById("scoreModeSel").value;
    const maxAllowed = parseInt(document.getElementById("maxShotsSel").value);
    let stopTriggered = false;

    if (scoreMode === "best2") {
        // Conta apenas até 2 tiros por alvo
        let validCount = 0;
        let targetGroups = {};
        shots.forEach(s => {
            if (!targetGroups[s.target]) targetGroups[s.target] = 0;
            if (targetGroups[s.target] < 2) {
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
    if(listContainer) {
        listContainer.innerHTML += `<button id="btn-tgt-modal-${idStr}" onclick="updateSelection('targetSel', '${idStr}', 'Alvo ${idStr}')" class="btn-modal-option">🎯 ALVO ${idStr}</button>`;
    }
    
    if (!silent) showToast("🎯 Alvo " + idStr + " pareado e registrado na telemetria.");
    
    // MÁGICA 3: Dá uma piscada verde no botão principal de Alvos para avisar
    let btnPrincipal = document.querySelector(`button[onclick="abrirModal('modal-target-sel')"]`);
    if(btnPrincipal) {
        btnPrincipal.style.boxShadow = "0 0 15px #4CAF50";
        setTimeout(() => btnPrincipal.style.boxShadow = "inset 0 2px 5px rgba(0,0,0,0.05)", 800);
    }
    
    // Desenha o papelão na Matriz Tática
    adicionarAlvoNaMatriz(idStr);
    
    return true;
}

// --- EXCEL (CSV) PROFISSIONAL ---
function saveRoundToCSV() {
    // 1. Verifica se tem dados
    if (allRoundsShots.length === 0 && shots.length === 0) {
        showToast("⚠️ Nenhum dado de treino para exportar.");
        return;
    }

    let atleta = document.getElementById("athleteName").value || "Atleta Anônimo";
    let dataHoje = new Date().toLocaleString('pt-BR');
    let hfMax = hfHistory.length > 0 ? Math.max(...hfHistory).toFixed(2).replace('.', ',') : "0,00";

    // 2. BOM (Byte Order Mark) - Mágica para o Excel ler acentos (UTF-8) perfeitamente
    let csvContent = "\uFEFF"; 

    // 3. Cabeçalho de Metadados
    csvContent += "=== RELATÓRIO DE TELEMETRIA - IPS Metrix ===\n";
    csvContent += `Atleta:;${atleta}\n`;
    csvContent += `Data do Treino:;${dataHoje}\n`;
    csvContent += `Melhor Hit Factor:;${hfMax}\n\n`;

    // 4. Nome das Colunas
    csvContent += "Rodada;Hit Factor;Tempo Total;Tiro #;Alvo;Zona;Pontos;Split (s);Tempo do Tiro (s)\n";

    const zonePts = { 'A': 5, 'C': 4, 'D': 2, 'M': -10, '-': 5 };

    // 5. Preenchimento de Dados Organizados
    allRoundsShots.forEach((rodada, rIdx) => {
        let hfRodada = hfHistory[rIdx] ? hfHistory[rIdx].toString().replace('.', ',') : "0,00";
        let tempoRodada = timeHistory[rIdx] ? timeHistory[rIdx].toString().replace('.', ',') : "0,00";

        rodada.forEach((s, sIdx) => {
            let split = (sIdx === 0) ? s.totalTime : (s.totalTime - rodada[sIdx-1].totalTime);
            let pts = zonePts[s.zone] !== undefined ? zonePts[s.zone] : 0;
            
            // Troca Ponto por Vírgula para o Excel BR reconhecer como número matemático
            let splitStr = split.toFixed(2).replace('.', ',');
            let tempoTiroStr = s.totalTime.toFixed(2).replace('.', ',');

            // Deixa a planilha limpa: Só escreve o "R1" na primeira linha do tiro
            let showRndInfo = (sIdx === 0) ? `R${rIdx+1};${hfRodada};${tempoRodada}` : `;;`;

            csvContent += `${showRndInfo};${sIdx+1};${s.target};${s.zone};${pts};${splitStr};${tempoTiroStr}\n`;
        });
    });

    // 6. Geração e Download
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
    const zonePts = { 'A': 5, 'C': 4, 'D': 2, 'M': -10, '-': 5 };

    shotArray.forEach((s, index) => {
        if (!targetGroups[s.target]) targetGroups[s.target] = [];
        targetGroups[s.target].push({ ...s, originalIndex: index, points: zonePts[s.zone] !== undefined ? zonePts[s.zone] : 0 });
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
        if (validShots[i].target !== validShots[i-1].target) {
            trans.push(validShots[i].totalTime - validShots[i-1].totalTime);
        }
    }
    
    // Separa os Double Taps (O tempo exato entre o 1º e 2º tiro válido no mesmo alvo)
    let tgMap = {};
    validShots.forEach(s => {
        if(!tgMap[s.target]) tgMap[s.target] = [];
        tgMap[s.target].push(s.totalTime);
    });
    
    for (let t in tgMap) {
        if (tgMap[t].length >= 2) {
            dtaps.push(tgMap[t][1] - tgMap[t][0]); // Mede do 1º para o 2º tiro no alvo
        }
    }

    let avgTrans = trans.length > 0 ? trans.reduce((a,b)=>a+b,0)/trans.length : 0;
    let avgDT = dtaps.length > 0 ? dtaps.reduce((a,b)=>a+b,0)/dtaps.length : 0;

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
    // 1. CABEÇALHO PROFISSIONAL
    // ==========================================
    doc.setFontSize(22);
    doc.setTextColor(25, 118, 210); // Azul Escuro
    doc.text("RELATÓRIO OFICIAL DE TREINO IPSC", 105, 20, { align: "center" });
    
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text(`Atleta: ${atleta}`, 20, 35);
    doc.text(`Data: ${new Date().toLocaleString()}`, 20, 42);
    
    let hfMax = hfHistory.length > 0 ? Math.max(...hfHistory) : 0;
    doc.setFont(undefined, 'bold');
    doc.text(`Melhor Hit Factor da Sessão: ${hfMax.toFixed(2)}`, 20, 55);
    doc.setFont(undefined, 'normal');

    // ==========================================
    // 2. TABELA DE RODADAS (COM ZONAS E EXTRAS)
    // ==========================================
    let yPos = 65;
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210);
    doc.text("Estatística de Impacto por Rodada:", 20, yPos);
    yPos += 10;
    
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    doc.setFillColor(240, 240, 240);
    doc.rect(20, yPos, 170, 8, 'F');
    
   // Cabeçalho da Tabela Expandido
    doc.setFont(undefined, 'bold');
    doc.text("Rodada", 22, yPos + 6);
    doc.text("A", 42, yPos + 6);
    doc.text("C", 52, yPos + 6);
    doc.text("D", 62, yPos + 6);
    doc.text("Met", 72, yPos + 6);  // Coluna para Metálico
    doc.text("Miss", 85, yPos + 6);
    doc.text("Ext", 100, yPos + 6); // Coluna para Extra Hits
    doc.text("Tempo", 115, yPos + 6);
    doc.text("Pts", 135, yPos + 6);
    doc.text("H.F", 155, yPos + 6);
    doc.setFont(undefined, 'normal');
    yPos += 8;

    let totalA = 0, totalC = 0, totalD = 0, totalM = 0, totalE = 0, totalMet = 0;

    // Preenchimento dos dados com leitura exata
    allRoundsShots.forEach((rodada, i) => {
        if (yPos > 260) { doc.addPage(); yPos = 20; }
        
       // Conta as zonas lendo as propriedades reais
        let rA = rodada.filter(s => s.zone === 'A').length;
        let rC = rodada.filter(s => s.zone === 'C').length;
        let rD = rodada.filter(s => s.zone === 'D').length;
        let rM = rodada.filter(s => s.zone === 'M').length;
        let rMet = rodada.filter(s => s.zone === '-').length; 
        
        // ESCUDO DO PDF: Conta os Extras, mas ignora os Metálicos para não duplicar!
        let rE = rodada.filter(s => s.isExtra && s.zone !== '-').length;
        totalA += rA; totalC += rC; totalD += rD; totalM += rM; totalE += rE; totalMet += rMet;

       doc.text(`R${i+1}`, 22, yPos + 6);
        doc.text(`${rA}`, 42, yPos + 6);
        doc.text(`${rC}`, 52, yPos + 6);
        doc.text(`${rD}`, 62, yPos + 6);
        doc.text(`${rMet}`, 72, yPos + 6);
        doc.text(`${rM}`, 85, yPos + 6);
        doc.text(`${rE}`, 100, yPos + 6);
        
        // ==========================================
        // MÁGICA: CÁLCULO DINÂMICO DE PONTOS E H.F.
        // ==========================================
        let tempoRound = parseFloat(timeHistory[i]) || 0;
        doc.text(`${tempoRound.toFixed(2)}s`, 115, yPos + 6);
        
        // IPSC Minor Score: A=5, C=3, D=1, Metal=5. Penalidades: Miss=-10, Extra=-10.
        // Se atirar de Major, basta trocar o * 3 por * 4 no Charlie, e o * 1 por * 2 no Delta.
        let ptsCalculados = (rA * 5) + (rC * 3) + (rD * 1) + (rMet * 5) - (rM * 10) - (rE * 10);
        
        // Cálculo real do Hit Factor (Pontos / Tempo). Se a pontuação for negativa, H.F zera.
        let hfCalculado = "0.00";
        if (ptsCalculados > 0 && tempoRound > 0) {
            hfCalculado = (ptsCalculados / tempoRound).toFixed(2);
        }
        
        // Imprime a Pontuação (Vermelho se for negativa)
        if (ptsCalculados < 0) doc.setTextColor(229, 57, 53); 
        doc.text(`${ptsCalculados}`, 135, yPos + 6);
        doc.setTextColor(0, 0, 0); // Volta pro preto
        
        // Imprime o Hit Factor real
        doc.setFont(undefined, 'bold');
        doc.text(`${hfCalculado}`, 155, yPos + 6);
        doc.setFont(undefined, 'normal');
        
        yPos += 8;
    });

    // ==========================================
    // 3. GRÁFICO DE HIT FACTOR (DA TELA)
    // ==========================================
    doc.addPage(); // Nova página para ficar limpo
    yPos = 20;
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210);
    doc.text("Evolução de Performance (Hit Factor):", 20, yPos);
    yPos += 10;

    if (typeof myChart !== 'undefined' && myChart !== null) {
        // Tira o "print" do gráfico já existente e converte pra imagem
        const imgChart = myChart.canvas.toDataURL('image/png', 1.0);
        doc.addImage(imgChart, 'PNG', 20, yPos, 170, 80); 
        yPos += 90;
    }

    // ==========================================
    // 4. GRÁFICO DE BARRAS DESENHADO 100% OFFLINE
    // ==========================================
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210);
    doc.text("Frequência de Impactos Totais:", 20, yPos);
    yPos += 15;

    // Configuração das Zonas e Cores Exatas
let zonasStats = [
        { label: "Alfa", val: totalA, color: [76, 175, 80] },      // Verde
        { label: "Charlie", val: totalC, color: [33, 150, 243] },  // Azul
        { label: "Delta", val: totalD, color: [255, 193, 7] },     // Amarelo
        { label: "Metal", val: totalMet, color: [158, 158, 158] }, // Cinza Chumbo (Igual ao ecrã)
        { label: "Miss", val: totalM, color: [229, 57, 53] },      // Vermelho
        { label: "Extra", val: totalE, color: [0, 0, 0] }          // Preto para os penalizados
    ];

    let maxValor = Math.max(totalA, totalC, totalD, totalMet, totalM, totalE);
    if (maxValor === 0) maxValor = 1; 

    let xBarra = 15; // Ajustado para caberem as 6 barras perfeitamente
    let alturaMaxBarra = 40;   

    // Desenha cada barra
    zonasStats.forEach(zona => {
        let altura = (zona.val / maxValor) * alturaMaxBarra;
        
        doc.setFillColor(zona.color[0], zona.color[1], zona.color[2]);
        doc.rect(xBarra, yPos + alturaMaxBarra - altura, 20, altura, 'F');
        
        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);
        doc.setFont(undefined, 'bold');
        doc.text(zona.val.toString(), xBarra + 10, yPos + alturaMaxBarra - altura - 2, { align: "center" });
        
        doc.setFont(undefined, 'normal');
        doc.text(zona.label, xBarra + 10, yPos + alturaMaxBarra + 5, { align: "center" });
        
        xBarra += 28; // Espaçamento entre as 6 barras
    });
    yPos += 60; 

   // ==========================================
    // 5. DIAGNÓSTICO PROFISSIONAL DA IA (COM DESIGN)
    // ==========================================
    // Se estiver muito no final da folha, joga a análise para a próxima página
    if (yPos > 230) { doc.addPage(); yPos = 20; } 
    
    // Título da Seção
    doc.setFontSize(14);
    doc.setTextColor(25, 118, 210); // Azul IPSC
    doc.setFont(undefined, 'bold');
    doc.text("Diagnóstico do 360 AI Analyst:", 20, yPos);
    yPos += 8;
    
    // Captura o texto da tela
    let aiTextRaw = document.getElementById("aiFeedback") ? document.getElementById("aiFeedback").innerText : "Sem análise disponível.";
    
    // Filtro cirúrgico: Mantém letras, números, pontuações e acentos do Português. Troca Emojis e Bugs por espaço.
    let textoLimpo = aiTextRaw.replace(/[^\w\s.,;:!?()%"'áéíóúãõçÁÉÍÓÚÃÕÇ\-]/gi, " ");
    
    // Remove excesso de espaços em branco e quebras de linha duplas
    textoLimpo = textoLimpo.replace(/\s{2,}/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    
    // Configura a fonte do corpo do texto (Elegante, cor chumbo e itálico)
    doc.setFontSize(11);
    doc.setTextColor(60, 60, 60); 
    doc.setFont(undefined, 'italic'); 
    
    // Divide o texto para caber perfeitamente dentro da caixa (margem menor)
    let splitAnalise = doc.splitTextToSize(textoLimpo, 160);
    
    // Calcula o tamanho exato que a caixa precisa ter baseada no tamanho do texto da IA
    let boxHeight = (splitAnalise.length * 5) + 10; 
    
    // Se a caixa inteira não couber no espaço restante, cria uma nova página
    if (yPos + boxHeight > 280) { doc.addPage(); yPos = 20; }
    
    // 🎨 DESENHO DA CAIXA DE FUNDO
    // 1. Fundo Cinza bem claro (Traz um ar limpo)
    doc.setFillColor(248, 249, 250);
    doc.rect(20, yPos, 170, boxHeight, 'F');
    
    // 2. Fita lateral Azul (O "Toque Premium")
    doc.setFillColor(25, 118, 210);
    doc.rect(20, yPos, 3, boxHeight, 'F');
    
    // 3. Imprime o texto perfeitamente alinhado dentro da caixa
    doc.text(splitAnalise, 28, yPos + 8);
    
    // ==========================================
    // 6. SALVA O DOCUMENTO
    // ==========================================
    doc.save(`Relatório_IPS_Metrix_${atleta.replace(/\s+/g, '_')}.pdf`);
}

// 3. IA de Análise Comparativa Cirúrgica (Dashboard Visual e Relatório)
async function runAICoach() {

    if (shots.length < 2) return;

    const scoreMode = document.getElementById("scoreModeSel").value;
    const isBestTwo = (scoreMode === "best2");

    let hfAtual = parseFloat(document.getElementById("hf").innerText);
    let validAtual = getValidShots(shots);
    let statsAtual = extractStats(validAtual);

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
        statsAnt = extractStats(validAnt);

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
        let prev = shots[i-1];
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
     // 🧠 TENSORFLOW.JS: INFERÊNCIA NEURAL ...
    // ==========================================================
    if (tfModel && validAtual.length > 2) {
        let zoneRank = { 'A': 5, '-': 5, 'C': 3, 'D': 1, 'M': 0 };
        let trainInputs = [];
        let trainOutputs = [];

        for (let i = 1; i < validAtual.length; i++) {
            let s = validAtual[i];
            let prev = validAtual[i-1];
            let isTrans = (s.target !== prev.target) ? 1 : 0;
            let split = s.totalTime - prev.totalTime;
            trainInputs.push([zoneRank[s.zone] || 0, isTrans]);
            trainOutputs.push([split]);
        }
        const xs = tf.tensor2d(trainInputs);
        const ys = tf.tensor2d(trainOutputs);
        await tfModel.fit(xs, ys, { epochs: 15, shuffle: true });
        
        if (worstTrans.time > 0) {
            let zVal = zoneRank[shots[worstTrans.shotNum-1].zone] || 0;
            
            const prediction = tfModel.predict(tf.tensor2d([[zVal, 1]]));
            let tempoPrevisto = prediction.dataSync()[0];
            let erroNeural = worstTrans.time - tempoPrevisto;

            if (erroNeural > 0.20) {
                feedback += `<br><span style="color:#1976D2;">[TELEMETRIA NEURAL] Desvio de Fluidez: A transição para o Alvo ${worstTrans.to} registrou atraso de ${erroNeural.toFixed(2)}s. Padrão indicativo de quebra de ritmo.</span><br>`;
            }
        }
        xs.dispose();
        ys.dispose();
    }
    
    // Agora o código sobrevive para chegar aqui e atualizar a tela!
    document.getElementById("aiFeedback").innerHTML = feedback;
// ==========================================================
    // 🗣️ PROTOCOLO DE ANÚNCIO E AUTO-START (INTELIGENTE)
    // ==========================================================
    
    // LÊ O TEMPO EXATO DA TELA
    let tempoTela = document.getElementById("chrono").innerText; // Ex: 0:02.45
    let partesTempo = tempoTela.split(/[:.]/);
    let tempoStr = `${parseInt(partesTempo[1])} ponto ${parseInt(partesTempo[2])}`; // Fala "2 ponto 45"
    let hfStr = hfAtual.toFixed(2).replace('.', ' ponto ');
    
    let autoMode = parseInt(document.getElementById("autoModeSel").value);
    if (autoMode > 0) { roundsCount++; }
    let isSequenceEnd = (autoMode > 0 && roundsCount >= autoMode); 

    // CÁLCULO CORRETO: Total de tiros - Válidos - Misses
    let totalMissesVoz = shots.filter(s => s.zone === 'M').length;
    let totalExtrasVoz = Math.max(0, shots.length - validAtual.length - totalMissesVoz);

    // 1. CONSTRÓI O RESUMÃO COMPLETO
    let resumao = `Tempo ${tempoStr}. Hit Factor ${hfStr}. `;
    
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

    speakCoach(fala, nextRoundCallback);}
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
    if(modal) {
        modal.style.display = 'flex';
    }
}

function fecharModais() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
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

function updateSelection(inputId, val, label) {
    const input = document.getElementById(inputId);
    if(input) input.value = val;
    
    // Tenta encontrar o rótulo da forma antiga ou da forma nova sem crashar
    let labelEl = document.getElementById('label-' + inputId.replace('Sel', '')) || document.getElementById('label-' + inputId);
    if(labelEl) labelEl.innerText = label;
    
    fecharModais();
    
    // Dispara gatilhos especiais
    if(inputId === 'targetSel') identificarAlvo();
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
// ==========================================
function adicionarAlvoNaMatriz(id) {
    const grid = document.getElementById('matriz-alvos-ipsc');
    if (!grid || document.getElementById(`wrapper-tgt-${id}`)) return;
    
    // As coordenadas "points" desenham o octógono exato da sua foto
    grid.innerHTML += `
    <div class="ipsc-wrapper anim-slide-up" id="wrapper-tgt-${id}">
        <div class="ipsc-label">ALVO ${id}</div>
        
        <div class="ipsc-tactical-box">
            <div class="target-hole left"></div>
            <div class="target-hole right"></div>
            
            <svg viewBox="0 0 110 130" class="ipsc-svg-target" id="svg-tgt-${id}">
                <polygon id="tgt-${id}-D" class="svg-zone-d" points="30,0 80,0 110,25 110,105 80,130 30,130 0,105 0,25" />
                
                <polygon id="tgt-${id}-C" class="svg-zone-c" points="36,15 74,15 94,33 94,97 74,115 36,115 16,97 16,33" />
                
                <polygon id="tgt-${id}-A" class="svg-zone-a" points="44,32 66,32 78,45 78,85 66,98 44,98 32,85 32,45" />
            </svg>
        </div>
    </div>`;
}
// ==========================================
// RENDERIZADOR DA MATRIZ TÁTICA (SVG MIL-SPEC)
// ==========================================
function atualizarMatrizVisual(idStr) {
    const wrapper = document.getElementById(`wrapper-tgt-${idStr}`);
    if (!wrapper) return;

    const isMetal = metallicTargets.has(parseInt(idStr));

   if (isMetal) {
        // VETOR: Réplica exata da 2ª Foto (Plástico preto em relevo octogonal + Prato branco)
        wrapper.innerHTML = `
            <div class="ipsc-label">ALVO ${idStr} (METAL)</div>
            <div class="ipsc-tactical-box">
                <svg class="ipsc-svg-target" viewBox="0 0 110 130" id="svg-tgt-${idStr}">
                    <polygon points="25,5 85,5 105,25 105,105 85,125 25,125 5,105 5,25" fill="#181818" stroke="#000000" stroke-width="3" />
                    
                    <circle class="svg-zone-m" id="tgt-${idStr}-M" cx="55" cy="65" r="34" />
                </svg>
            </div>
        `;
    } else {
        // VETOR: O Alvo de Papel (Octógono)
        wrapper.innerHTML = `
            <div class="ipsc-label">ALVO ${idStr}</div>
            <div class="ipsc-tactical-box">
                <svg class="ipsc-svg-target" viewBox="0 0 110 130" id="svg-tgt-${idStr}">
                    <polygon class="svg-zone-d" id="tgt-${idStr}-D" points="25,5 85,5 105,25 105,105 85,125 25,125 5,105 5,25" />
                    <polygon class="svg-zone-c" id="tgt-${idStr}-C" points="32,20 78,20 90,32 90,98 78,110 32,110 20,98 20,32" />
                    <polygon class="svg-zone-a" id="tgt-${idStr}-A" points="42,35 68,35 75,45 75,85 68,95 42,95 35,85 35,45" />

                    <text x="12" y="68" font-family="Arial" font-weight="900" font-size="8" fill="#222">D</text>
                    <text x="92" y="68" font-family="Arial" font-weight="900" font-size="8" fill="#222">D</text>
                    <text x="25" y="68" font-family="Arial" font-weight="900" font-size="8" fill="#222">C</text>
                    <text x="80" y="68" font-family="Arial" font-weight="900" font-size="8" fill="#222">C</text>
                    <text x="52" y="68" font-family="Arial" font-weight="900" font-size="9" fill="#222">A</text>
                </svg>
            </div>
        `;
    }
}

function adicionarAlvoNaMatriz(id) {
    const grid = document.getElementById('matriz-alvos-ipsc');
    if (!grid) return;
    
    if (!document.getElementById(`wrapper-tgt-${id}`)) {
        grid.innerHTML += `<div class="ipsc-wrapper anim-slide-up" id="wrapper-tgt-${id}"></div>`;
    }
    atualizarMatrizVisual(id);
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

    if(!svgBox) return;

    // 1. Limpa todas as classes ativas
    svgBox.classList.remove('flash-miss');
    if(alpha) alpha.classList.remove('flash-alpha');
    if(charlie) charlie.classList.remove('flash-charlie');
    if(delta) delta.classList.remove('flash-delta');
    if(metal) metal.classList.remove('flash-metal');

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
        if(alpha) alpha.classList.remove('flash-alpha');
        if(charlie) charlie.classList.remove('flash-charlie');
        if(delta) delta.classList.remove('flash-delta');
        if(metal) metal.classList.remove('flash-metal');
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
    let statsAtual = extractStats(validAtual);

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
        statsAnt = extractStats(validAnt);
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
    for(let i = 0; i < realAtual.length; i++) {
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