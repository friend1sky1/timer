/* 流程计时器 v0.3 —— 事件方块时间线：拖拽排序 + 自动连播。无广告，离线可用 */
(function () {
  'use strict';

  /* ---------- 纯逻辑 ---------- */
  function formatTime(totalSec) {
    const s = Math.max(0, Math.ceil(totalSec));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function formatDur(min, sec) {
    return min > 0 ? min + '分' + (sec > 0 ? sec + '秒' : '') : sec + '秒';
  }

  /* 方块内短时长：30min / 5min30s / 45s */
  function formatDurShort(min, sec) {
    if (min === 0) return sec + 's';
    if (sec === 0) return min + 'min';
    return min + 'min' + sec + 's';
  }

  /* ---------- 默认时间线（上课五环节模板） ---------- */
  const DEFAULT_EVENTS = [
    { id: 'e1', name: '情境导入', min: 5, sec: 0 },
    { id: 'e2', name: '核心输入', min: 100, sec: 0 },
    { id: 'e3', name: '强制休息', min: 15, sec: 0 },
    { id: 'e4', name: '实战输出', min: 90, sec: 0 },
    { id: 'e5', name: '总结答疑', min: 30, sec: 0 }
  ];

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const ringWrap = $('ringWrap');
  const ringProgress = $('ringProgress');
  const timeDisplay = $('timeDisplay');
  const stateText = $('stateText');
  const startBtn = $('startBtn');
  const skipBtn = $('skipBtn');
  const resetBtn = $('resetBtn');
  const fullscreenBtn = $('fullscreenBtn');
  const ringtoneSel = $('ringtoneSel');
  const timeline = $('timeline');
  const timelineInfo = $('timelineInfo');
  const eventForm = $('eventForm');
  const eventName = $('eventName');
  const eventMin = $('eventMin');
  const eventSec = $('eventSec');
  const resetEventsBtn = $('resetEventsBtn');

  const CIRCUM = 2 * Math.PI * 138; // 与 SVG r=138 对应
  ringProgress.style.strokeDasharray = CIRCUM;

  /* ---------- 事件存储 ---------- */
  let events = loadEvents();
  let dragIndex = null;

  function loadEvents() {
    try {
      const raw = localStorage.getItem('timeline-v1');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return DEFAULT_EVENTS.map(function (s) { return Object.assign({}, s); });
  }

  function saveEvents() {
    try { localStorage.setItem('timeline-v1', JSON.stringify(events)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 播放状态 ---------- */
  let total = 0;          // 当前事件总秒数
  let remain = 0;         // 剩余秒数
  let endAt = 0;
  let timerId = null;    // setInterval 句柄（用 interval 而非 rAF：后台标签页也能计时响铃）
  let currentIndex = 0;   // 当前事件下标
  let state = 'idle';     // idle | running | paused | done
  let audioCtx = null;
  let switchTimer = null;  // 事件切换延时句柄（需统一清理，防止延迟回调复活状态机）

  /* ---------- 铃声（Web Audio，首次点击初始化） ---------- */
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep(freq, delay, dur, vol, fade) {
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    if (fade) {
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    } else {
      gain.gain.setValueAtTime(vol, t0 + dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function playRingtone(kind) {
    ensureAudio(); // 响铃前保险恢复音频上下文（可能因系统策略进入 suspended）
    if (kind === 'none' || !audioCtx) return;
    if (kind === 'bell') {
      // 上课铃：三连音组 ×3 轮，明显持久（总长约 4.5 秒）
      for (let round = 0; round < 3; round++) {
        const base = round * 1.5;
        beep(880, base, 0.4, 0.6);
        beep(880, base + 0.5, 0.4, 0.6);
        beep(1174.66, base + 1.0, 0.5, 0.6);
      }
    } else {
      // 轻柔音：两段渐弱，柔和持久（总长约 3.6 秒）
      beep(523.25, 0, 1.2, 0.3, true);
      beep(523.25, 1.6, 1.2, 0.3, true);
    }
  }

  /* 铃声总时长（毫秒），用于自动切换的等待时间 */
  function ringtoneDuration() {
    const kind = ringtoneSel.value;
    if (kind === 'bell') return 4600;
    if (kind === 'soft') return 3800;
    return 600; // 静音也稍等，避免瞬间切走
  }

  /* 更新当前方块进度（已用比例填充玻璃管） */
  function updateProgress() {
    const p = document.querySelector('.event-row.active .event-progress');
    if (!p || total <= 0) return;
    const done = total - remain;
    const pct = Math.min(100, Math.max(0, done / total * 100));
    p.style.width = pct + '%';
  }

  /* ---------- 界面更新 ---------- */
  function render() {
    const ratio = total > 0 ? remain / total : 0;
    ringProgress.style.strokeDashoffset = String(CIRCUM * (1 - ratio));
    timeDisplay.textContent = formatTime(remain);
    updateProgress();

    ringWrap.classList.remove('warn', 'done', 'running');
    stateText.classList.remove('done');

    if (state === 'running') {
      ringWrap.classList.add('running');
      if (remain <= 60) ringWrap.classList.add('warn');
      startBtn.textContent = '暂停';
      startBtn.classList.remove('paused');
    } else if (state === 'paused') {
      stateText.textContent = '已暂停';
      startBtn.textContent = '继续';
      startBtn.classList.add('paused');
    } else if (state === 'done') {
      ringWrap.classList.add('done');
      stateText.textContent = '流程完成！';
      stateText.classList.add('done');
      startBtn.textContent = '重新开始';
      startBtn.classList.remove('paused');
    } else {
      startBtn.textContent = '开始流程';
      startBtn.classList.remove('paused');
    }

    if (state === 'running' || state === 'paused') {
      const ev = events[currentIndex];
      if (ev) {
        const seq = (currentIndex + 1) + '/' + events.length;
        stateText.textContent = ev.name + ' · ' + seq;
      }
    }
  }

  function updateTimelineInfo() {
    let totalSec = 0;
    events.forEach(function (ev) { totalSec += ev.min * 60 + ev.sec; });
    const totalMin = Math.round(totalSec / 60);
    timelineInfo.textContent = events.length + ' 个事件 · 共 ' + totalMin + ' 分钟';
  }

  /* ---------- 主循环（setInterval 200ms + 时间戳，后台标签页照常走） ---------- */
  function tick() {
    remain = Math.max(0, (endAt - Date.now()) / 1000);
    render();
    if (remain <= 0) {
      clearInterval(timerId); // 到点先停 interval，防止重复触发 onEventEnd（多次响铃）
      onEventEnd();
    }
  }

  function startCurrent() {
    clearTimeout(switchTimer);
    clearInterval(timerId);
    const ev = events[currentIndex];
    if (!ev) { finishFlow(); return; }
    total = ev.min * 60 + ev.sec;
    remain = total;
    state = 'running';
    endAt = Date.now() + remain * 1000;
    renderTimeline();
    render();
    tick();
    timerId = setInterval(tick, 200);
  }

  function onEventEnd() {
    playRingtone(ringtoneSel.value);
    if (currentIndex + 1 < events.length) {
      currentIndex++;
      // 等铃声播完再进下一个（避免上一事件铃声未响完就切换）
      switchTimer = setTimeout(startCurrent, ringtoneDuration());
    } else {
      finishFlow();
    }
  }

  function finishFlow() {
    clearTimeout(switchTimer);
    clearInterval(timerId);
    state = 'done';
    remain = 0;
    renderTimeline();
    render();
  }

  function pauseFlow() {
    if (state !== 'running') return;
    clearTimeout(switchTimer);
    clearInterval(timerId);
    state = 'paused';
    remain = Math.max(0, (endAt - Date.now()) / 1000);
    render();
  }

  function resetFlow() {
    clearTimeout(switchTimer);
    clearInterval(timerId);
    state = 'idle';
    currentIndex = 0;
    const ev = events[0];
    total = ev ? ev.min * 60 + ev.sec : 0;
    remain = total;
    renderTimeline();
    render();
  }

  function skipTo(index) {
    if (index < 0 || index >= events.length) return;
    clearTimeout(switchTimer);
    currentIndex = index;
    if (state === 'running' || state === 'paused') {
      startCurrent();
    } else {
      state = 'idle';
      const ev = events[index];
      total = ev ? ev.min * 60 + ev.sec : 0;
      remain = total;
      renderTimeline();
      render();
    }
  }

  /* 拖入圆环：直接启动该事件（视频剪辑式交互） */
  function dropToStart(index) {
    if (index < 0 || index >= events.length) return;
    clearTimeout(switchTimer);
    currentIndex = index;
    ensureAudio(); // drop 属于用户手势，可初始化/恢复音频
    startCurrent();
  }

  /* ---------- 时间线渲染与操作 ---------- */
  function renderTimeline() {
    timeline.innerHTML = '';
    events.forEach(function (ev, i) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const isActive = i === currentIndex && (state === 'running' || state === 'paused');
      if (isActive) row.classList.add('active');
      row.draggable = true;
      row.title = ev.name + ' ' + formatDur(ev.min, ev.sec);

      // 拖拽手柄
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';

      // 名称标签（固定列，完整显示）
      const label = document.createElement('span');
      label.className = 'event-label';
      label.textContent = ev.name;

      // 时长条（真实比例：flex-grow = 总秒数，100min 是 5min 的 20 倍宽）
      const bar = document.createElement('div');
      bar.className = 'event-bar';
      bar.style.flexGrow = String(ev.min * 60 + ev.sec);

      // 时长文字（条内右侧，条窄时被裁剪）
      const barDur = document.createElement('span');
      barDur.className = 'event-bar-dur';
      barDur.textContent = formatDurShort(ev.min, ev.sec);

      // 进度填充（玻璃管）
      const progress = document.createElement('div');
      progress.className = 'event-progress';

      bar.appendChild(progress);
      bar.appendChild(barDur);

      // 删除
      const del = document.createElement('span');
      del.className = 'event-del';
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeEvent(i);
      });

      row.appendChild(handle);
      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(del);

      // 点击：跳转到该事件（播放中=切到该事件）
      row.addEventListener('click', function () {
        if (state === 'running' || state === 'paused') skipTo(i);
      });
      // 拖拽排序（HTML5 DnD）
      row.addEventListener('dragstart', function (e) {
        dragIndex = i;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        if (dragIndex === null || dragIndex === i) return;
        const from = dragIndex;
        const to = i;
        const moved = events.splice(from, 1)[0];
        events.splice(to, 0, moved);
        if (from === currentIndex) currentIndex = to; // 拖走当前事件：跟走
        else if (from < currentIndex && to >= currentIndex) currentIndex--;
        else if (from > currentIndex && to <= currentIndex) currentIndex++;
        saveEvents();
        renderTimeline();
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        dragIndex = null;
      });

      timeline.appendChild(row);
    });
    updateTimelineInfo();
  }

  function removeEvent(index) {
    if (events.length <= 1) return; // 至少保留一个事件
    clearTimeout(switchTimer);
    const removingCurrent = index === currentIndex;
    events.splice(index, 1);
    if (index < currentIndex) currentIndex--;
    if (currentIndex >= events.length) currentIndex = events.length - 1;
    if (removingCurrent && (state === 'running' || state === 'paused')) {
      startCurrent(); // 删除正在播放的事件：切到下一个
    } else {
      const ev = events[currentIndex] || events[0];
      total = ev ? ev.min * 60 + ev.sec : 0;
      remain = total;
    }
    saveEvents();
    renderTimeline();
    render();
  }

  function addEvent(name, min, sec) {
    events.push({ id: 'u' + Date.now(), name: name, min: min, sec: sec });
    saveEvents();
    renderTimeline();
  }

  function resetEvents() {
    clearTimeout(switchTimer);
    events = DEFAULT_EVENTS.map(function (s) { return Object.assign({}, s); });
    currentIndex = 0;
    saveEvents();
    renderTimeline();
    render();
  }

  /* ---------- 事件 ---------- */
  startBtn.addEventListener('click', function () {
    if (state === 'running') pauseFlow();
    else if (state === 'done') { resetFlow(); startCurrent(); }
    else if (state === 'paused') startCurrent();
    else {
      ensureAudio();
      startCurrent();
    }
  });

  skipBtn.addEventListener('click', function () {
    if (events.length === 0) return;
    if (currentIndex + 1 < events.length) skipTo(currentIndex + 1);
    else finishFlow();
  });

  resetBtn.addEventListener('click', resetFlow);

  fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  });

  eventForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const name = eventName.value.trim();
    const m = Math.max(0, parseInt(eventMin.value, 10) || 0);
    const s = Math.max(0, Math.min(59, parseInt(eventSec.value, 10) || 0));
    if (!name) { eventName.focus(); return; }
    if (m + s <= 0) {
      eventMin.focus();
      return; // 0 分 0 秒不添加，提示用户填时长
    }
    addEvent(name, m, s);
    eventName.value = '';
    eventName.focus();
  });

  resetEventsBtn.addEventListener('click', resetEvents);

  /* 圆环作为启动区：拖入事件方块即启用倒计时 */
  let dragEnterCount = 0;
  ringWrap.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragEnterCount++;
    ringWrap.classList.add('drop-hover');
  });
  ringWrap.addEventListener('dragleave', function () {
    dragEnterCount--;
    if (dragEnterCount <= 0) {
      dragEnterCount = 0;
      ringWrap.classList.remove('drop-hover');
    }
  });
  ringWrap.addEventListener('dragover', function (e) {
    e.preventDefault(); // 允许 drop
  });
  ringWrap.addEventListener('drop', function (e) {
    e.preventDefault();
    dragEnterCount = 0;
    ringWrap.classList.remove('drop-hover');
    dropToStart(dragIndex);
  });

  // 键盘：空格 开始/暂停；→ 下一个；← 上一个
  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, select, button')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      startBtn.click();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      skipBtn.click();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (currentIndex > 0) skipTo(currentIndex - 1);
    }
  });

  /* ---------- 初始 ---------- */
  renderTimeline();
  resetFlow();
})();
