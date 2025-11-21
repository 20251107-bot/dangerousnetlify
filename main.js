/*
  Teachable Machine + Smartphone Vibration
  - Loads TM image model from server files (keras_model.h5 + labels.txt)
  - Runs webcam inference loop
  - Applies threshold (85%) + steady-frame hysteresis
  - Vibrates smartphone when danger detected
*/

const ui = {
  video: document.getElementById('video'),
  videoPreview: document.getElementById('videoPreview'),
  overlay: document.getElementById('overlay'),
  btnCamera: document.getElementById('btnCamera'),
  btnStart: document.getElementById('btnStart'),
  threshold: document.getElementById('threshold'),
  steadyFrames: document.getElementById('steadyFrames'),
  status: document.getElementById('status'),
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  modelStatus: document.getElementById('modelStatus'),
  modelStatusContent: document.getElementById('modelStatusContent'),
};

let DANGER_LABELS = []; // 위험 라벨들 (labels.txt에서 자동 로드)

let model = null;
let webcamStream = null;
let isRunning = false;
let animationHandle = null;
let isVibrating = false;
let vibrationInterval = null;
let shouldVibrate = false;

// 드래그 관련 변수
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

const log = (msg) => {
  // 로그 출력 제거됨
  console.log(msg);
};

function setStatus(text, isDetecting = false) {
  // 상태 텍스트 표시 제거됨
}

// 원형 표시 상태 업데이트
function updateStatusIndicator(modelWorking, dangerDetected, isDetecting = false, cameraWorking = true) {
  if (!ui.statusIndicator) return;
  
  // 모델과 카메라가 모두 작동하고, 감지 중일 때만 빨간색/초록색 표시
  if (modelWorking && cameraWorking && isDetecting) {
    // 모델과 카메라가 모두 작동하고 감지 중일 때 위험지대 분류되면: 빨간색
    if (dangerDetected) {
      ui.statusIndicator.className = 'status-indicator danger';
      ui.statusIndicator.textContent = '⚠️';
      return;
    }
    
    // 모델과 카메라가 모두 작동하고 감지 중일 때 안전하면: 초록색
    ui.statusIndicator.className = 'status-indicator safe';
    ui.statusIndicator.textContent = '✓';
    return;
  }
  
  // 이외의 상황에서는 모두 노란색 (감지 시작 안 했거나, 모델/카메라 작동 안 할 때)
  ui.statusIndicator.className = 'status-indicator warning';
  ui.statusIndicator.textContent = '⚠';
}

// 모델 작동 현황 업데이트
function updateModelStatus(predictions, best, confirmed) {
  if (!ui.modelStatus || !ui.modelStatusContent) return;
  
  if (predictions) {
    // 기존 내용 제거
    ui.modelStatusContent.innerHTML = '';
    
    // 평지 라벨 확인 (안전으로 표시)
    const GROUND_LABELS = ['평지', 'ground', '평면', '바닥', '안전'];
    
    // 고정된 순서로 표시 (모델의 라벨 순서 유지)
    // predictions 배열의 순서를 유지하되, DANGER_LABELS 순서에 맞춰 정렬
    let orderedPredictions = [];
    if (DANGER_LABELS && DANGER_LABELS.length > 0) {
      // DANGER_LABELS 순서대로 predictions에서 찾아서 추가
      DANGER_LABELS.forEach(label => {
        const found = predictions.find(p => p.className === label);
        if (found) {
          orderedPredictions.push(found);
        }
      });
      // DANGER_LABELS에 없는 예측 결과도 추가
      predictions.forEach(p => {
        if (!DANGER_LABELS.includes(p.className)) {
          orderedPredictions.push(p);
        }
      });
    } else {
      // DANGER_LABELS가 없으면 원래 순서 유지
      orderedPredictions = predictions;
    }
    
    // 각 예측 결과를 항목으로 표시 (고정된 순서)
    orderedPredictions.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'prediction-item';
      
      // 라벨과 퍼센트 행
      const row = document.createElement('div');
      row.className = 'prediction-row';
      
      const label = document.createElement('span');
      label.className = 'prediction-label';
      // 평지인 경우 "(안전)" 추가
      const isSafe = GROUND_LABELS.some(groundLabel => 
        p.className.toLowerCase().includes(groundLabel.toLowerCase())
      );
      label.textContent = isSafe ? `${p.className} (안전)` : p.className;
      
      const value = document.createElement('span');
      value.className = 'prediction-value';
      value.textContent = (p.probability * 100).toFixed(1) + '%';
      
      row.appendChild(label);
      row.appendChild(value);
      
      // 바 차트 컨테이너
      const barContainer = document.createElement('div');
      barContainer.className = 'prediction-bar-container';
      
      const bar = document.createElement('div');
      bar.className = 'prediction-bar';
      bar.style.width = (p.probability * 100) + '%';
      
      // 평지(안전)는 초록색, 나머지는 파란색
      if (isSafe) {
        bar.classList.add('safe');
      } else {
        bar.classList.add('danger');
      }
      
      barContainer.appendChild(bar);
      
      item.appendChild(row);
      item.appendChild(barContainer);
      ui.modelStatusContent.appendChild(item);
    });
  }
}

// 원형 표시 위치 저장
function saveIndicatorPosition() {
  if (ui.statusIndicator) {
    const rect = ui.statusIndicator.getBoundingClientRect();
    const position = {
      left: rect.left,
      top: rect.top
    };
    localStorage.setItem('statusIndicatorPosition', JSON.stringify(position));
  }
}

// 원형 표시 위치 복원
function loadIndicatorPosition() {
  if (ui.statusIndicator) {
    const saved = localStorage.getItem('statusIndicatorPosition');
    if (saved) {
      try {
        const position = JSON.parse(saved);
        ui.statusIndicator.style.left = position.left + 'px';
        ui.statusIndicator.style.top = position.top + 'px';
        return;
      } catch (e) {
        console.error('위치 복원 실패:', e);
      }
    }
    // 기본 위치 (우측 상단)
    ui.statusIndicator.style.left = (window.innerWidth - 70) + 'px';
    ui.statusIndicator.style.top = '20px';
  }
}

// 드래그 시작
function startDrag(e) {
  if (!ui.statusIndicator) return;
  isDragging = true;
  const rect = ui.statusIndicator.getBoundingClientRect();
  dragOffset.x = e.clientX - rect.left;
  dragOffset.y = e.clientY - rect.top;
  e.preventDefault();
}

// 드래그 중
function onDrag(e) {
  if (!isDragging || !ui.statusIndicator) return;
  const x = e.clientX - dragOffset.x;
  const y = e.clientY - dragOffset.y;
  
  // 화면 경계 체크
  const maxX = window.innerWidth - ui.statusIndicator.offsetWidth;
  const maxY = window.innerHeight - ui.statusIndicator.offsetHeight;
  
  ui.statusIndicator.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  ui.statusIndicator.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
}

// 드래그 종료
function endDrag() {
  if (isDragging) {
    isDragging = false;
    saveIndicatorPosition();
  }
}

async function openCamera() {
  if (webcamStream) {
    // 이미 카메라가 켜져 있으면 종료
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
    ui.video.srcObject = null;
    if (ui.videoPreview) {
      ui.videoPreview.srcObject = null;
    }
    log('카메라 종료됨');
    setStatus('카메라 종료', false);
    // 카메라 종료 시 모델 상태에 따라 표시
    updateStatusIndicator(model !== null, false, false, false);
    return;
  }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ 
      video: { 
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }, 
      audio: false 
    });
    ui.video.srcObject = webcamStream;
    if (ui.videoPreview) {
      ui.videoPreview.srcObject = webcamStream;
    }
    await ui.video.play();
    if (ui.videoPreview) {
      await ui.videoPreview.play();
    }
    
    // 비디오 크기에 맞춰 overlay 크기 조정
    ui.video.addEventListener('loadedmetadata', () => {
      ui.overlay.width = ui.video.videoWidth || ui.video.clientWidth;
      ui.overlay.height = ui.video.videoHeight || ui.video.clientHeight;
    });
    
    log('카메라 시작됨 - 정면 화면 송출 중');
    setStatus('카메라 작동 중', false);
    // 카메라 시작 시 모델 상태에 따라 표시
    updateStatusIndicator(model !== null, false, false, true);
  } catch (e) {
    log(`카메라 오류: ${e.message}`);
    setStatus('카메라 오류', false);
    // 카메라 오류 시 노란색
    updateStatusIndicator(model !== null, false, false, false);
  }
}

async function loadModel() {
  try {
    setStatus('모델 로딩 중...', false);
    log('모델 파일 다운로드 중...');

    const modelURL = './model.json';
    const metadataURL = './metadata.json';

    model = await tmImage.load(modelURL, metadataURL);

    DANGER_LABELS = model.getClassLabels();
    log(`✓ 모델 로드 완료! (${modelURL})`);
    log(`라벨: ${DANGER_LABELS.join(', ')}`);
    setStatus('모델 준비 완료', false);
    updateStatusIndicator(true, false, false, webcamStream !== null);
  } catch (e) {
    log(`✗ 모델 로드 실패: ${e.message}`);
    log('Teachable Machine에서 웹용 모델을 다운로드해주세요.');
    log('(Export Model → TensorFlow.js 선택)');
    setStatus('모델 로드 실패', false);
    updateStatusIndicator(false, false, false, webcamStream !== null);
  }
}

// 평지를 제외한 클래스에서 90% 이상 확률인지 확인
function shouldVibrateForNonGround(predictions) {
  if (!predictions || predictions.length === 0) return false;
  
  const GROUND_LABELS = ['평지', 'ground', '평면', '바닥']; // 평지로 간주할 라벨들
  
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    // 평지가 아니고 90% 이상 확률인 경우
    const isGround = GROUND_LABELS.some(groundLabel => 
      p.className.toLowerCase().includes(groundLabel.toLowerCase())
    );
    
    if (!isGround && p.probability >= 0.9) {
      return true;
    }
  }
  return false;
}

// 1초씩 진동하는 패턴 시작 (1초 진동, 1초 정지 반복)
function startVibrationPattern() {
  if (!('vibrate' in navigator)) {
    log('이 기기는 진동을 지원하지 않습니다.');
    return;
  }
  
  if (vibrationInterval) return; // 이미 실행 중이면 중복 실행 방지
  
  shouldVibrate = true;
  isVibrating = true;
  
  // 즉시 첫 진동 시작
  navigator.vibrate(1000);
  
  // 1초 진동, 1초 정지 패턴 반복
  // 1초마다 체크하여 진동/정지를 번갈아 실행
  let isVibratingNow = true; // 현재 진동 중인지 여부
  vibrationInterval = setInterval(() => {
    if (shouldVibrate && isRunning) {
      if (isVibratingNow) {
        // 1초 진동 후 정지
        navigator.vibrate(0);
        isVibratingNow = false;
      } else {
        // 1초 정지 후 진동
        navigator.vibrate(1000);
        isVibratingNow = true;
      }
    } else {
      stopVibrationPattern();
    }
  }, 1000); // 1초마다 체크
}

// 진동 패턴 중지
function stopVibrationPattern() {
  shouldVibrate = false;
  isVibrating = false;
  if (vibrationInterval) {
    clearInterval(vibrationInterval);
    vibrationInterval = null;
  }
  navigator.vibrate(0); // 진동 즉시 중지
}

// 기존 함수들 (하위 호환성 유지)
function vibrateDevice() {
  if (!('vibrate' in navigator)) {
    log('이 기기는 진동을 지원하지 않습니다.');
    return;
  }
  // 지속적인 진동 패턴: 500ms 진동
  if (!isVibrating) {
    isVibrating = true;
    navigator.vibrate(500);
  }
}

function stopVibration() {
  stopVibrationPattern();
}

function getDangerFromPredictions(predictions, threshold) {
  // predictions: [{className, probability}] from Teachable Machine
  let best = { label: null, prob: 0, index: -1 };
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    if (p.probability > best.prob) {
      best = { label: p.className, prob: p.probability, index: i };
    }
  }
  if (best.label && best.prob >= threshold) return best;
  return { label: null, prob: 0 };
}

const hysteresisState = {
  lastLabel: null,
  startTime: null,
};

function updateHysteresis(currentLabel, requiredSeconds) {
  const now = performance.now();
  
  if (currentLabel && currentLabel === hysteresisState.lastLabel) {
    // 같은 라벨이 계속 감지되는 경우
    if (hysteresisState.startTime === null) {
      hysteresisState.startTime = now;
    }
    // 경과 시간 확인
    const elapsedSeconds = (now - hysteresisState.startTime) / 1000;
    return elapsedSeconds >= requiredSeconds ? hysteresisState.lastLabel : null;
  } else if (currentLabel) {
    // 새로운 라벨이 감지된 경우
    hysteresisState.lastLabel = currentLabel;
    hysteresisState.startTime = now;
    return null;
  } else {
    // 라벨이 없는 경우
    hysteresisState.lastLabel = null;
    hysteresisState.startTime = null;
    return null;
  }
}

async function inferenceLoop() {
  if (!model || !webcamStream) {
    log('모델 또는 카메라가 준비되지 않았습니다.');
    setStatus('준비되지 않음', false);
    // 모델 또는 카메라 미준비 시 노란색
    updateStatusIndicator(model !== null, false, false, webcamStream !== null);
    return;
  }
  isRunning = true;
  setStatus('감지 중...', true);
  if (ui.modelStatus) ui.modelStatus.style.display = 'block';
  const ctx = ui.overlay.getContext('2d');

  const step = async () => {
    if (!isRunning) return;
    try {
      // Teachable Machine 모델로 예측
      const predictions = await model.predict(ui.video);

      const threshold = parseFloat(ui.threshold.value) || 0.85;
      const requiredSeconds = parseFloat(ui.steadyFrames.value) || 1.5;
      const best = getDangerFromPredictions(predictions, threshold);

      const confirmed = updateHysteresis(best.label, requiredSeconds);

      // 진동 제어를 위한 위험 감지 확인
      const shouldVibrate90 = shouldVibrateForNonGround(predictions);

      // Draw overlay - 위험지대 감지 시 빨간색 깜빡임만
      ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
      
      // 위험지대 감지 여부 확인
      const hasDangerForFlash = confirmed || shouldVibrate90 || (best.label && best.prob >= threshold);
      const GROUND_LABELS = ['평지', 'ground', '평면', '바닥', '안전'];
      const isBestSafe = best.label && GROUND_LABELS.some(groundLabel => 
        best.label.toLowerCase().includes(groundLabel.toLowerCase())
      );
      
      // 위험지대 감지 시 화면 전체 빨간색 깜빡이는 효과
      if (hasDangerForFlash && !isBestSafe) {
        const flashIntensity = 0.3 + Math.sin(Date.now() / 200) * 0.3;
        ctx.fillStyle = `rgba(255, 0, 0, ${flashIntensity})`;
        ctx.fillRect(0, 0, ui.overlay.width, ui.overlay.height);
      }

      // 진동 제어
      // 1. 평지를 제외한 클래스에서 90% 이상 확률인 경우: 1초씩 진동
      if (shouldVibrate90) {
        startVibrationPattern();
      } else {
        stopVibrationPattern();
        // 2. 기존 로직: 확정된 위험 객체 감지 시 진동
        if (confirmed) {
          vibrateDevice();
        } else {
          stopVibration();
        }
      }

      // 모델 작동 현황 업데이트
      updateModelStatus(predictions, best, confirmed);
      
      // 원형 표시 업데이트
      // 모델 정상 작동 + 위험지대 인식 여부 확인
      const hasDanger = confirmed || shouldVibrate90 || (best.label && best.prob >= threshold);
      updateStatusIndicator(true, hasDanger, true, true); // 감지 중이므로 isDetecting = true, 카메라 작동 중
      
      setStatus('감지 중...', true);
    } catch (e) {
      log(`감지 오류: ${e.message}`);
      setStatus('감지 오류', false);
      updateModelStatus(null, null, false);
      // 모델 오류 시 노란색 표시
      updateStatusIndicator(false, false, false, webcamStream !== null);
    }
    animationHandle = requestAnimationFrame(step);
  };
  animationHandle = requestAnimationFrame(step);
}

function stopLoop() {
  isRunning = false;
  stopVibrationPattern();
  stopVibration();
  setStatus('정지됨', false);
  // 정지 시에도 모델 상태는 계속 표시
  if (animationHandle) cancelAnimationFrame(animationHandle);
  // overlay 초기화
  const ctx = ui.overlay.getContext('2d');
  ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
  // 정지 시 모델과 카메라 상태에 따라 표시 (감지 중이 아니므로 초록색 V표시)
  updateStatusIndicator(model !== null, false, false, webcamStream !== null);
}

ui.btnCamera.addEventListener('click', openCamera);
ui.btnStart.addEventListener('click', inferenceLoop);

// 원형 표시 드래그 이벤트
if (ui.statusIndicator) {
  // 마우스 이벤트
  ui.statusIndicator.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
  
  // 터치 이벤트 (모바일 지원)
  ui.statusIndicator.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    startDrag({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
  });
  document.addEventListener('touchmove', (e) => {
    if (isDragging) {
      e.preventDefault();
      const touch = e.touches[0];
      onDrag({ clientX: touch.clientX, clientY: touch.clientY });
    }
  });
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);
  
  // 페이지 로드 시 위치 복원 (기존 load 이벤트와 함께 실행)
  if (document.readyState === 'loading') {
    window.addEventListener('load', () => {
      setTimeout(() => {
        loadIndicatorPosition();
      }, 100);
    });
  } else {
    // 이미 로드된 경우 즉시 실행
    setTimeout(() => {
      loadIndicatorPosition();
    }, 100);
  }
  
  // 창 크기 변경 시 위치 조정
  window.addEventListener('resize', () => {
    if (ui.statusIndicator) {
      const rect = ui.statusIndicator.getBoundingClientRect();
      const maxX = window.innerWidth - ui.statusIndicator.offsetWidth;
      const maxY = window.innerHeight - ui.statusIndicator.offsetHeight;
      
      if (rect.left > maxX || rect.top > maxY) {
        ui.statusIndicator.style.left = Math.max(0, Math.min(rect.left, maxX)) + 'px';
        ui.statusIndicator.style.top = Math.max(0, Math.min(rect.top, maxY)) + 'px';
        saveIndicatorPosition();
      }
    }
  });
}

// 디버그: 스크립트 실행 확인
console.log('=== main.js 스크립트 로드됨 ===');
console.log('window 객체:', typeof window);
console.log('document 객체:', typeof document);

// 페이지 로드 시 자동으로 모델 로드
let appInitialized = false;

function checkLibraryAndInit() {
  if (appInitialized) return;
  appInitialized = true;
  
  console.log('=== 초기화 시작 ===');
  console.log('tf 타입:', typeof tf);
  console.log('tmImage 타입:', typeof tmImage);
  
  log('앱 시작됨');
  setStatus('초기화 중...', false);
  // 초기 상태: 노란색 (모델 미로드, 카메라 미작동)
  updateStatusIndicator(false, false, false, false);
  
  // TensorFlow.js 확인
  if (typeof tf === 'undefined') {
    log('✗ TensorFlow.js 로드 실패');
    console.error('TensorFlow.js가 로드되지 않았습니다.');
    setStatus('TF.js 로드 실패', false);
    updateStatusIndicator(false, false, false, webcamStream !== null);
    return;
  }
  
  log('✓ TensorFlow.js 로드 완료');
  
  // Teachable Machine 확인
  if (typeof tmImage === 'undefined') {
    log('✗ Teachable Machine 라이브러리 로드 실패');
    console.error('Teachable Machine 라이브러리가 로드되지 않았습니다.');
    setStatus('tmImage 로드 실패', false);
    updateStatusIndicator(false, false, false, webcamStream !== null);
    return;
  }
  
  log('✓ Teachable Machine 라이브러리 로드 완료');
  log('모델을 자동으로 로드합니다...');
  setStatus('모델 로딩 중...', false);
  loadModel();
}

// 페이지 로드 후 초기화 (3초 대기)
console.log('=== 이벤트 리스너 등록 ===');
window.addEventListener('load', () => {
  console.log('=== window.load 이벤트 발생 ===');
  setTimeout(() => {
    console.log('=== 3초 대기 후 초기화 시작 ===');
    checkLibraryAndInit();
  }, 3000);
});



