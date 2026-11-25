import { createFlowStartIntent, startDurableFlow, updateDurableFlowProject, settleDurableFlow, settleCheckpointFlow, flowStartTime, validateFlowEnd } from './timers/sessions.js';
import { recordsInRange, segmentHours, splitTimeSegments, preserveSegmentedTiming, timeStatsFor as sharedTimeStatsFor } from './model/time.js';
import { initializeWorkbench } from './bootstrap.js';
import { parseProfileBackup, makeProfileBackup, aiReportProjection, reportOverrideKey } from './model/workspace.js';
import { validateAvatar } from './profile/avatar.js';
const workbench = await initializeWorkbench();
const sessionIds = {};
const sessionRuns = {};
let checkpointBusy = false;

    function useStandaloneStorage() {
      window.appStorage = workbench.storage;
    }
    useStandaloneStorage();
    const legacyStoreKey = 'jiepai-work-logs-v1';
    const profilesStoreKey = 'jiepai-user-profiles-v1';
    const activeProfileStoreKey = 'jiepai-active-profile-v1';
    const profileDataKey = (id) => 'jiepai-work-logs-v2:' + id;
    const profileTasksKey = (id) => 'jiepai-project-tasks-v1:' + id;
    const safeJsonRead = (key, fallback) => {
      try {
        const raw = window.appStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        return fallback;
      }
    };
    function normalizeCategory(value) {
      const category = String(value || '').trim();
      if (['项目推进', '会议讨论', '对外协商', '项目整理'].includes(category)) return category;
      if (category === '沟通协作') return '会议讨论';
      if (category === '深度思考' || category === '日常事务') return '项目整理';
      return '项目推进';
    }
    function normalizeLog(item) {
      return item && typeof item === 'object' ? { ...item, category: normalizeCategory(item.category), meetingContent: String(item.meetingContent || '').slice(0, 5000) } : item;
    }
    function normalizeTask(item, index) {
      if (!item || typeof item !== 'object') return null;
      const text = String(item.text || '').trim().slice(0, 240);
      if (!text) return null;
      return {
        id: String(item.id || ('task-' + Date.now() + '-' + index + '-' + Math.random().toString(16).slice(2))),
        project: String(item.project || '').trim().slice(0, 120),
        text,
        completed: Boolean(item.completed),
        createdAt: String(item.createdAt || new Date().toISOString()),
        completedAt: item.completed ? String(item.completedAt || new Date().toISOString()) : '',
        source: String(item.source || '工作录入').slice(0, 40),
        batchId: String(item.batchId || item.id || ('task-batch-' + Date.now() + '-' + index)).slice(0, 100)
      };
    }
    function normalizeTasks(value) {
      return (Array.isArray(value) ? value : []).map(normalizeTask).filter(Boolean);
    }
    function initializeProfiles() {
      const existing = safeJsonRead(profilesStoreKey, null);
      if (Array.isArray(existing) && existing.length) {
        const validProfiles = existing.filter((item) => item && item.id && item.name);
        if (validProfiles.length) return validProfiles;
      }
      const starter = { id: 'personal-' + Date.now(), name: '我的工作台' };
      const legacyLogs = safeJsonRead(legacyStoreKey, []);
      window.appStorage.setItem(profilesStoreKey, JSON.stringify([starter]));
      window.appStorage.setItem(activeProfileStoreKey, starter.id);
      window.appStorage.setItem(profileDataKey(starter.id), JSON.stringify(Array.isArray(legacyLogs) ? legacyLogs : []));
      window.appStorage.setItem(profileTasksKey(starter.id), JSON.stringify([]));
      return [starter];
    }
    let profiles = initializeProfiles();
    let activeProfileId = window.appStorage.getItem(activeProfileStoreKey);
    if (!profiles.some((item) => item.id === activeProfileId)) activeProfileId = profiles[0].id;
    let logs = safeJsonRead(profileDataKey(activeProfileId), []);
    if (!Array.isArray(logs)) logs = [];
    logs = logs.map(normalizeLog);
    let tasks = normalizeTasks(safeJsonRead(profileTasksKey(activeProfileId), []));
    let reportOverrides = {};
    let mode = 'week';
    let editingId = null;
    let periodReportEditing = false;
    let dailyReportEditing = false;
    let meetingStartedAt = null;
    let meetingTimer = null;
    let meetingDraft = null;
    let flowStartedAt = null;
    let flowStartIntent=null,flowStartBusy=false,flowFinishIntent=null,flowFinishBusy=false,flowPageEpoch=0;
    let flowTimer = null;
    let flowDraftTasks = [];
    let meetingDraftTasks = [];
    let taskTracking = null;
    let taskTrackingTimer = null;
    const get = (id) => document.getElementById(id);
    const today = () => dateKey(new Date());
    get('work-date').value = today();
    get('anchor-date').value = today();
    get('daily-date').value = today();
    get('backfill-start-date').value = today();
    get('backfill-end-date').value = today();
    const painDialog = get('pain-dialog');
    const dataDialog = get('data-dialog');
    const meetingDialog = get('meeting-dialog');
    get('start-time').value = '09:00';
    get('end-time').value = '10:00';

    function currentProfile() {
      return profiles.find((item) => item.id === activeProfileId) || profiles[0];
    }
    function persistProfiles() {
      window.appStorage.setItem(profilesStoreKey, JSON.stringify(profiles));
      window.appStorage.setItem(activeProfileStoreKey, activeProfileId);
    }
    function uniqueProfileName(value) {
      const base = String(value || '恢复的工作台').trim().slice(0, 30) || '恢复的工作台';
      const names = profiles.map((item) => item.name);
      if (!names.includes(base)) return base;
      let number = 2;
      while (names.includes(base.slice(0,30-String(number).length-2) + '（' + number + '）')) number += 1;
      return base.slice(0,30-String(number).length-2) + '（' + number + '）';
    }
    function renderProfiles() {
      const active = currentProfile();
      get('current-user-name').textContent = active.name;
      workbench.avatar(get('current-user-avatar'), active.avatar);
      get('user-list').innerHTML = profiles.map((item) =>
        '<div class="user-row' + (item.id === activeProfileId ? ' active' : '') + '"><div><span>' + escapeHtml(item.name) + '</span><small>' + (item.id === activeProfileId ? '当前使用中' : '独立工作区') + '</small></div>' + (item.id === activeProfileId ? '<small>当前</small>' : '<button class="switch-user" data-profile-id="' + escapeHtml(item.id) + '" type="button">切换</button>') + '</div>'
      ).join('');
      for (const [index,item] of profiles.entries()) { const target=get('user-list').children[index]?.firstElementChild; if(target){const a=document.createElement('span');a.className='avatar avatar-list';workbench.avatar(a,item.avatar);target.prepend(a);} }
    }
    function switchProfile(id) {
      if (flowStartedAt || meetingStartedAt || taskTracking || meetingDraft) { toast('请先结束计时再切换用户。'); return; }
      const target = profiles.find((item) => item.id === id);
      if (!target || target.id === activeProfileId) return;
      cancelAiReport();
      resetReportEditors();
      activeProfileId = target.id;
      logs = safeJsonRead(profileDataKey(activeProfileId), []);
      if (!Array.isArray(logs)) logs = [];
      logs = logs.map(normalizeLog);
      tasks = normalizeTasks(safeJsonRead(profileTasksKey(activeProfileId), []));
      reportOverrides = target.reportOverrides || {};
      taskTracking = null;
      if (taskTrackingTimer) window.clearInterval(taskTrackingTimer);
      taskTrackingTimer = null;
      persistProfiles();
      resetWorkForm();
      render();
      renderProfiles();
      toast('已切换到“' + target.name + '”。');
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[char]);
    }
    function renderProjectHistory() {
      const projects = [...new Set([
        ...logs.slice().sort((a, b) => b.workDate.localeCompare(a.workDate) || b.id - a.id).map((item) => String(item.project || '').trim()),
        ...tasks.map((item) => String(item.project || '').trim())
      ].filter(Boolean))];
      get('project-history').innerHTML = projects.map((project) => '<option value="' + escapeHtml(project) + '"></option>').join('');
    }
    function taskSummary(drafts) {
      return drafts.map((task, index) => String(index + 1) + '. ' + task.text + (task.completed ? '（已完成）' : '')).join('\n');
    }
    function openTasksFor(project) {
      const normalizedProject = String(project || '').trim();
      return tasks.filter((task) => !task.completed && (!normalizedProject || task.project === normalizedProject));
    }
    function addPersistentTasks(project, drafts, source) {
      const normalizedProject = String(project || '').trim();
      const createdAt = new Date().toISOString();
      const batchId = 'task-batch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const additions = drafts.filter((task) => String(task.text || '').trim()).map((task, index) => ({
        id: 'task-' + Date.now() + '-' + index + '-' + Math.random().toString(16).slice(2),
        project: normalizedProject,
        text: String(task.text).trim().slice(0, 240),
        completed: Boolean(task.completed),
        createdAt,
        completedAt: task.completed ? createdAt : '',
        source,
        batchId
      }));
      tasks.push(...additions);
      return additions;
    }
    function draftTasksFor(kind) {
      return kind === 'flow' ? flowDraftTasks : meetingDraftTasks;
    }
    function setDraftTasks(kind, value) {
      if (kind === 'flow') flowDraftTasks = value; else meetingDraftTasks = value;
    }
    function renderDraftTasks(kind) {
      const list = get(kind + '-task-list');
      const rows = draftTasksFor(kind);
      list.innerHTML = rows.map((task, index) => {
        const sourceControl = task.sourceTaskId
          ? '<span class="task-source">同步任务</span>'
          : '<button class="task-remove" type="button" data-draft-action="remove" data-draft-kind="' + kind + '" data-draft-index="' + index + '">删除</button>';
        return '<li class="task-draft-item"><div class="task-row' + (task.completed ? ' done' : '') + '"><span class="task-text">' + escapeHtml(task.text) + '</span><button class="task-state' + (task.completed ? ' done' : '') + '" type="button" data-draft-action="toggle" data-draft-kind="' + kind + '" data-draft-index="' + index + '">' + (task.completed ? '已完成' : '完成') + '</button>' + sourceControl + '</div></li>';
      }).join('');
    }
    function addDraftTask(kind) {
      const input = get(kind + '-task-input');
      const text = input.value.trim();
      if (!text) return;
      const rows = draftTasksFor(kind).slice();
      rows.push({ text: text.slice(0, 240), completed: false });
      setDraftTasks(kind, rows);
      input.value = '';
      renderDraftTasks(kind);
      input.focus();
    }
    function syncFlowProjectTasks() {
      const project = get('flow-project').value.trim();
      const manualTasks = flowDraftTasks.filter((task) => !task.sourceTaskId);
      const syncedTasks = project ? openTasksFor(project).map((task) => ({ text: task.text, completed: Boolean(task.completed), sourceTaskId: task.id })) : [];
      flowDraftTasks = [...manualTasks, ...syncedTasks];
      renderDraftTasks('flow');
    }
    function updateTaskTrackingControls() {
      document.querySelectorAll('[data-track-project]').forEach((button) => {
        const active = taskTracking && taskTracking.project === button.dataset.trackProject;
        button.classList.toggle('tracking', Boolean(active));
        button.textContent = active ? '不追踪' : '追踪任务';
      });
      document.querySelectorAll('[data-tracking-elapsed]').forEach((node) => {
        node.textContent = taskTracking ? '追踪中 ' + formatMeetingElapsed(Date.now() - taskTracking.startedAt.getTime()) : '';
      });
    }
    function renderPendingTasks() {
      const panel = get('pending-task-panel');
      const selectedProject = get('project').value.trim();
      const selectedOpenTasks = selectedProject ? openTasksFor(selectedProject) : [];
      const visibleTasks = selectedOpenTasks.length ? selectedOpenTasks : openTasksFor('');
      const grouped = {};
      visibleTasks.forEach((task) => {
        const project = task.project || '未归类项目';
        (grouped[project] ||= new Set()).add(task.batchId || task.id);
      });
      panel.hidden = !visibleTasks.length;
      if (!visibleTasks.length) return;
      get('pending-task-title').textContent = selectedOpenTasks.length ? '“' + selectedProject + '”待完成任务' : '待完成任务';
      get('pending-task-subtitle').textContent = selectedOpenTasks.length ? '这些未完成任务已自动带入当前项目，可在此逐条完成。' : '选择项目后会优先显示该项目任务；也可直接追踪下方项目。';
      get('pending-task-count').textContent = visibleTasks.length + ' 项';
      get('pending-task-groups').innerHTML = Object.entries(grouped).map(([project, batchIds]) => {
        const active = taskTracking && taskTracking.project === project;
        const projectTasks = tasks.filter((task) => (task.project || '未归类项目') === project && batchIds.has(task.batchId || task.id));
        const taskRows = projectTasks.map((task) => '<li class="task-item"><div class="task-row' + (task.completed ? ' done' : '') + '"><span class="task-text">' + escapeHtml(task.text) + '</span><button class="task-state' + (task.completed ? ' done' : '') + '" type="button" data-toggle-task="' + escapeHtml(task.id) + '">' + (task.completed ? '已完成' : '完成') + '</button></div></li>').join('');
        return '<section class="pending-task-group"><div class="pending-task-group-top"><div><strong>' + escapeHtml(project) + '</strong>' + (active ? '<div class="tracking-note" data-tracking-elapsed></div>' : '') + '</div><button class="track-task' + (active ? ' tracking' : '') + '" type="button" data-track-project="' + escapeHtml(project) + '">' + (active ? '不追踪' : '追踪任务') + '</button></div><ol class="task-list">' + taskRows + '</ol></section>';
      }).join('');
      updateTaskTrackingControls();
    }
    function renderTaskCenter() {
      const container = get('task-center-groups');
      const openTasks = openTasksFor('');
      get('task-center-count').textContent = openTasks.length + ' 项待完成';
      if (!openTasks.length) {
        container.innerHTML = '<div class="task-center-empty">当前没有待完成任务。<br>可以在上方选择所属项目，新增下一项工作。</div>';
        return;
      }
      const groups = {};
      openTasks.forEach((task) => {
        const project = task.project || '未归类项目';
        (groups[project] ||= []).push(task);
      });
      container.innerHTML = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([project, projectTasks]) => {
        const completedCount = tasks.filter((task) => (task.project || '未归类项目') === project && task.completed).length;
        const active = taskTracking && taskTracking.project === project;
        const taskRows = projectTasks.map((task) => '<li class="task-item"><div class="task-row"><span class="task-text">' + escapeHtml(task.text) + '</span><button class="task-state" type="button" data-toggle-task="' + escapeHtml(task.id) + '">完成</button></div></li>').join('');
        return '<section class="task-center-group"><div class="task-center-group-head"><div class="task-center-project-name"><strong>' + escapeHtml(project) + '</strong><span>' + projectTasks.length + ' 项待完成' + (completedCount ? ' · 已完成 ' + completedCount + ' 项' : '') + (active ? ' · 追踪中' : '') + '</span></div><button class="track-task' + (active ? ' tracking' : '') + '" type="button" data-track-project="' + escapeHtml(project) + '">' + (active ? '不追踪' : '追踪任务') + '</button></div><ol class="task-list">' + taskRows + '</ol></section>';
      }).join('');
      updateTaskTrackingControls();
    }
    function clearTaskTrackingTimer() {
      if (taskTrackingTimer) window.clearInterval(taskTrackingTimer);
      taskTrackingTimer = null;
    }
    async function startTaskTracking(project) {
      const normalizedProject = String(project || '').trim();
      if (!normalizedProject) return;
      if (taskTracking && taskTracking.project === normalizedProject) {
        stopTaskTracking(false);
        return;
      }
      if (taskTracking) { stopTaskTracking(false); await workbench.flushLegacy(); }
      taskTracking = { project: normalizedProject, startedAt: new Date() };
      get('project').value = normalizedProject;
      clearTaskTrackingTimer();
      taskTrackingTimer = window.setInterval(updateTaskTrackingControls, 1000);
      await beginSession('task');
      renderPendingTasks();
      toast('已开始追踪“' + normalizedProject + '”，再次点击“不追踪”即可结束并记录时长。');
    }
    function stopTaskTracking(automaticallyCompleted) {
      if (!taskTracking) return;
      const tracking = taskTracking;
      const endedAt = new Date();
      taskTracking = null;
      clearTaskTrackingTimer();
      const elapsedHours = (endedAt.getTime() - tracking.startedAt.getTime()) / 3600000;
      if (elapsedHours > 0 && elapsedHours <= 24) {
        const startTime = timeString(tracking.startedAt);
        let endTime = timeString(endedAt);
        if (startTime === endTime) endTime = timeAfter(startTime, 1 / 60);
        const remaining = openTasksFor(tracking.project);
        const record = {
          id: Date.now(),
          workDate: dateKey(tracking.startedAt),
          title: (automaticallyCompleted ? '任务追踪完成：' : '任务追踪：') + tracking.project,
          project: tracking.project,
          category: '项目推进',
          hours: Math.max(1 / 60, elapsedHours),
          startTime,
          endTime,
          progress: automaticallyCompleted || !remaining.length ? 100 : 50,
          outcome: automaticallyCompleted ? '待完成任务已全部完成。' : '本次追踪结束；仍有 ' + remaining.length + ' 项待完成任务。',
          nextStep: remaining.map((task) => task.text).join('；'),
          meetingContent: '', painPoint: '', painSolution: '', painStatus: '已解决', painResponse: ''
        };
        applySessionRecord(record, 'task'); logs.push(record);
      }
      save();
      toast(automaticallyCompleted ? '该项目待完成任务已全部完成，追踪工作已自动记录。' : '已结束任务追踪，并将本次时长计入工作记录。');
    }
    function togglePersistentTask(id) {
      const task = tasks.find((item) => item.id === id);
      if (!task) return;
      task.completed = !task.completed;
      task.completedAt = task.completed ? new Date().toISOString() : '';
      const allDone = task.completed && !openTasksFor(task.project).length;
      if (allDone && taskTracking && taskTracking.project === task.project) {
        stopTaskTracking(true);
        return;
      }
      save();
      toast(task.completed ? '任务已标记为完成。' : '任务已恢复为待完成状态。');
    }
    function dateKey(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    function prettyDate(value) {
      return new Intl.DateTimeFormat('zh-CN', { month:'short', day:'numeric', weekday:'short' }).format(new Date(value + 'T12:00:00'));
    }
    function durationHours(startTime, endTime) {
      const start = startTime.split(':').map(Number);
      const end = endTime.split(':').map(Number);
      let startMinutes = start[0] * 60 + start[1];
      let endMinutes = end[0] * 60 + end[1];
      if (endMinutes <= startMinutes) endMinutes += 24 * 60;
      return (endMinutes - startMinutes) / 60;
    }
    function timeAfter(startTime, hours) {
      const start = startTime.split(':').map(Number);
      const minutes = Math.round((start[0] * 60 + start[1] + hours * 60) % (24 * 60));
      return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
    }
    function updateDurationPreview() {
      const existing=editingId?logs.find(item=>item.id===editingId):null;
      const hours=existing?.timeSegments?existing.hours:durationHours(get('start-time').value,get('end-time').value);
      get('duration-preview').textContent=hours.toFixed(1)+' 小时';
    }
    function rangeFor(currentMode, anchor) {
      const parsed = new Date(anchor + 'T12:00:00');
      const pivot = Number.isFinite(parsed.getTime()) ? parsed : new Date(today() + 'T12:00:00');
      const start = new Date(pivot);
      const end = new Date(pivot);
      if (currentMode === 'week') {
        start.setDate(pivot.getDate() - ((pivot.getDay() + 6) % 7));
        end.setTime(start.getTime());
        end.setDate(start.getDate() + 6);
      } else if (currentMode === 'month') {
        start.setDate(1);
        end.setMonth(pivot.getMonth() + 1, 0);
      } else {
        start.setMonth(0, 1);
        end.setMonth(11, 31);
      }
      return { start: dateKey(start), end: dateKey(end) };
    }
    function modeName(currentMode) {
      return currentMode === 'week' ? '周度' : currentMode === 'month' ? '月度总结' : '年度总结';
    }
    function summaryHeading(currentMode) {
      return currentMode === 'week' ? '周度工作总结：' : currentMode === 'month' ? '月度工作总结：' : '年度工作总结：';
    }
    function selectedLogs() {
      const range = rangeFor(mode, get('anchor-date').value);
      return recordsInRange(logs, range).sort((a, b) => a.workDate.localeCompare(b.workDate));
    }
    function minutesFor(time) {
      const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
      if (!match) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours > 23 || minutes > 59) return null;
      return hours * 60 + minutes;
    }
    function timeRangeFor(item) {
      const start = minutesFor(item.startTime);
      if (start === null) return null;
      let end = minutesFor(item.endTime);
      if (end === null) end = start + Math.max(1, Number(item.hours) || 1) * 60;
      if (end <= start) end += 24 * 60;
      return { start, end, project: item.project || '未归类项目' };
    }
    function timeStatsFor(items) {
      return sharedTimeStatsFor(items);
    }
    function workDetailFor(item) {
      let detail = item.outcome || ('当前进度 ' + item.progress + '%');
      if (item.meetingContent) detail = '会议内容：' + item.meetingContent + (item.outcome ? '；会议产出：' + item.outcome : '');
      if (item.painPoint || item.painSolution || item.painResponse) {
        if (item.painPoint) detail += '；工作痛点：' + item.painPoint + '（' + item.painStatus + '）';
        if (item.painSolution) detail += '；解决方案：' + item.painSolution;
        if (item.painResponse) detail += '；处理说明 / 待跟进行动：' + item.painResponse;
      }
      return detail;
    }
    function cleanText(value) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text;
    }
    function compactText(value, maxLength) {
      const text = cleanText(value);
      if (!text) return '';
      return text.length > (maxLength || 72) ? text.slice(0, maxLength || 72) + '…' : text;
    }
    function reportText(value, maxLength, preserveFullText) {
      return preserveFullText ? cleanText(value) : compactText(value, maxLength);
    }
    function distinctTexts(values, maxCount, maxLength, preserveFullText = false) {
      return [...new Set(values.map((value) => reportText(value, maxLength, preserveFullText)).filter(Boolean))].slice(0, maxCount || 3);
    }
    function joinReportPoints(values) {
      return values.map((value) => String(value || '').replace(/[。；;]+$/g, '').trim()).filter(Boolean).join('；');
    }
    function timeWindow(items) {
      const starts = items.map((item) => item.startTime).filter(Boolean).sort();
      const ends = items.map((item) => item.endTime).filter(Boolean).sort();
      return starts.length && ends.length ? starts[0] + '–' + ends[ends.length - 1] : '时间未记录';
    }
    function projectsFor(items) {
      const grouped = {};
      items.forEach((item) => { const project = item.project || '未归类项目'; (grouped[project] ||= []).push(item); });
      return grouped;
    }
    function timelineSummaryLines(items) {
      const byDay = {};
      items.slice().sort((a, b) => a.workDate.localeCompare(b.workDate) || String(a.startTime || '').localeCompare(String(b.startTime || ''))).forEach((item) => { (byDay[item.workDate] ||= []).push(item); });
      return Object.entries(byDay).flatMap(([date, dayItems]) => Object.entries(projectsFor(dayItems)).map(([project, projectItems]) => {
        const achievements = distinctTexts(projectItems.map((item) => item.outcome || item.meetingContent || item.title), 2, 58);
        const completed = projectItems.filter((item) => Number(item.progress) >= 100).length;
        return '• ' + prettyDate(date) + '｜' + timeWindow(projectItems) + '｜【' + project + '】推进 ' + projectItems.length + ' 项，完成 ' + completed + ' 项' + (achievements.length ? '；关键进展：' + achievements.join('；') : '；持续推进相关工作。');
      }));
    }
    function projectProgressLines(items, projectHours, preserveFullText = false) {
      return Object.entries(projectsFor(items)).sort((a, b) => (projectHours[b[0]] || 0) - (projectHours[a[0]] || 0)).map(([project, projectItems]) => {
        const averageProgress = Math.round(projectItems.reduce((sum, item) => sum + Math.max(0, Math.min(100, Number(item.progress) || 0)), 0) / projectItems.length);
        const outcomes = distinctTexts(projectItems.map((item) => item.outcome || (item.meetingContent ? '完成会议讨论' : '')), 2, 66, preserveFullText);
        const painCount = projectItems.filter((item) => item.painPoint && item.painStatus === '未解决').length;
        return '【' + project + '】累计投入 ' + (projectHours[project] || 0).toFixed(1) + ' 小时，覆盖 ' + projectItems.length + ' 项工作，平均进度 ' + averageProgress + '%' + (outcomes.length ? '；阶段成果：' + outcomes.join('；') : '') + (painCount ? '；仍有 ' + painCount + ' 项风险待处理。' : '；当前推进平稳。');
      });
    }
    function dateInRange(value, range) {
      const key = String(value || '').slice(0, 10);
      return key && key >= range.start && key <= range.end;
    }
    function resolvedLines(items, range, preserveFullText = false) {
      const painResolved = items.filter((item) => item.painPoint && item.painStatus !== '未解决').map((item) => '【' + (item.project || '未归类项目') + '】' + reportText(item.painPoint, 54, preserveFullText) + (item.painSolution ? '；处理：' + reportText(item.painSolution, 54, preserveFullText) : '；已完成处理。'));
      const completedTasks = tasks.filter((task) => task.completed && dateInRange(task.completedAt, range)).map((task) => '【' + (task.project || '未归类项目') + '】' + reportText(task.text, 72, preserveFullText));
      return distinctTexts([...painResolved, ...completedTasks], 12, 140, preserveFullText);
    }
    function pendingLines(items, preserveFullText = false) {
      const involvedProjects = new Set(items.map((item) => item.project || '未归类项目'));
      const unresolvedPains = items.filter((item) => item.painPoint && item.painStatus === '未解决').map((item) => '【' + (item.project || '未归类项目') + '】问题：' + reportText(item.painPoint, 62, preserveFullText) + (item.painResponse ? '；待跟进：' + reportText(item.painResponse, 58, preserveFullText) : '。'));
      const openTaskLines = tasks.filter((task) => !task.completed && (!involvedProjects.size || involvedProjects.has(task.project || '未归类项目'))).map((task) => '【' + (task.project || '未归类项目') + '】任务：' + reportText(task.text, 72, preserveFullText));
      return distinctTexts([...unresolvedPains, ...openTaskLines], 16, 150, preserveFullText);
    }
    function nextPlanLines(items, preserveFullText = false) {
      const recordPlans = items.map((item) => item.nextStep).filter(Boolean);
      const involvedProjects = new Set(items.map((item) => item.project || '未归类项目'));
      const openTaskPlans = tasks.filter((task) => !task.completed && (!involvedProjects.size || involvedProjects.has(task.project || '未归类项目'))).map((task) => '【' + (task.project || '未归类项目') + '】' + task.text);
      return distinctTexts([...recordPlans, ...openTaskPlans], 12, 120, preserveFullText);
    }
    function collaborationLines(items, preserveFullText = false) {
      return items.filter((item) => ['会议讨论', '对外协商'].includes(item.category)).map((item) => '• ' + prettyDate(item.workDate) + '｜【' + (item.project || '未归类项目') + '】' + item.category + '：' + reportText(item.meetingContent || item.outcome || item.title, 92, preserveFullText));
    }
    function projectInsight(project, projectItems, projectHours, preserveFullText = false) {
      const completed = projectItems.filter((item) => Number(item.progress) >= 100).length;
      const averageProgress = Math.round(projectItems.reduce((sum, item) => sum + Math.max(0, Math.min(100, Number(item.progress) || 0)), 0) / projectItems.length);
      const results = distinctTexts(projectItems.map((item) => item.outcome || item.meetingContent), 3, 82, preserveFullText);
      const taskTitles = distinctTexts(projectItems.map((item) => item.title), 3, 54, preserveFullText);
      const situations = distinctTexts(projectItems.map((item) => item.painPoint || item.meetingContent || item.title), 2, 72, preserveFullText);
      const actions = distinctTexts([
        ...projectItems.map((item) => item.painSolution),
        ...projectItems.filter((item) => ['会议讨论', '对外协商'].includes(item.category)).map((item) => item.meetingContent || item.outcome),
        ...projectItems.map((item) => item.outcome)
      ], 3, 86, preserveFullText);
      const solutions = distinctTexts(projectItems.map((item) => item.painSolution), 2, 78, preserveFullText);
      const nextSteps = distinctTexts([
        ...projectItems.map((item) => item.nextStep),
        ...tasks.filter((task) => !task.completed && task.project === project).map((task) => task.text)
      ], 3, 82, preserveFullText);
      const unresolved = projectItems.filter((item) => item.painPoint && item.painStatus === '未解决').map((item) => reportText(item.painPoint, 72, preserveFullText));
      const hasClearResult = results.length || completed > 0;
      const headline = hasClearResult
        ? '【' + project + '】｜投入 ' + (projectHours[project] || 0).toFixed(1) + ' 小时，关键事项已形成阶段成果'
        : '【' + project + '】｜已聚焦推进关键事项，正在从执行走向可交付结果';
      const learning = solutions.length
        ? '从“' + solutions[0] + '”中沉淀了可复用的处理路径，后续同类问题可优先采用该方法。'
        : actions.length
          ? '在推进过程中验证了“先明确目标、再同步行动、最后用结果复盘”的工作方式；后续应继续记录关键决策。'
          : '本期尚未单独记录方法复盘；建议后续补充关键决策和解决方案，以沉淀可复用经验。';
      return { project, hours: projectHours[project] || 0, completed, total: projectItems.length, averageProgress, results, tasks: taskTitles, situations, actions, solutions, nextSteps, unresolved, headline, learning };
    }
    function focusProjectInsights(items, projectHours, preserveFullText = false) {
      return Object.entries(projectsFor(items))
        .sort((a, b) => (projectHours[b[0]] || 0) - (projectHours[a[0]] || 0))
        .map(([project, projectItems]) => projectInsight(project, projectItems, projectHours, preserveFullText));
    }
    function buildStructuredReport(items, range, heading, preserveFullText = false) {
      const timeStats = timeStatsFor(items);
      const total = timeStats.total;
      const done = items.filter((item) => Number(item.progress) >= 100).length;
      const projects = [...new Set(items.map((item) => item.project).filter(Boolean))];
      if (!items.length) {
        return { total, done, projects: projects.length, projectHours: timeStats.projectHours, text: [heading, '', '一、结论先行｜当前尚无可复盘的数据', '', '1. 成果展示｜本期暂无工作记录，尚未形成可展示的阶段成果。', '2. 复盘与成长｜建议从下一条记录开始补充“产出、解决方案和下一步”，让系统能够沉淀 STAR-L 复盘。', '3. 未来规划｜先确定最重要的项目与一项可验证的交付目标。', '', '二、成果展示｜先记录结果，才能清晰展示价值', '', '暂无。', '', '三、复盘与成长｜用 STAR-L 沉淀有效方法', '', '暂无。', '', '四、未来规划｜把下一步转化为可执行任务', '', pendingLines(items, preserveFullText).length ? pendingLines(items, preserveFullText).map((item, index) => String(index + 1) + '. ' + item).join('\n') : '暂无待完成任务。', '', '数据看板：项目投入图、完成事项与项目数会在报告页面同步展示。'].join('\n') };
      }
      const activeDays = new Set(items.map((item) => item.workDate)).size;
      const resolved = resolvedLines(items, range, preserveFullText);
      const pending = pendingLines(items, preserveFullText);
      const plans = nextPlanLines(items, preserveFullText);
      const insights = focusProjectInsights(items, timeStats.projectHours, preserveFullText);
      const coreInsights = insights.slice(0, 3);
      const otherProjects = insights.slice(3).map((item) => item.project);
      const leading = coreInsights[0];
      const progressText = coreInsights.map((item) => '【' + item.project + '】' + item.completed + '/' + item.total + ' 项完成').join('；');
      const resultOverview = distinctTexts(coreInsights.flatMap((item) => item.results), 3, 78, preserveFullText);
      const priorityPlans = plans.slice(0, 3);
      const lines = [
        heading, '',
        '一、结论先行｜先看三项最重要的阶段判断', '',
        '1. 成果聚焦｜本期覆盖 ' + activeDays + ' 个工作日、' + projects.length + ' 个项目，实际投入 ' + total.toFixed(1) + ' 小时；' + (leading ? '工作重心集中在【' + leading.project + '】。' : '已形成清晰的项目投入重心。'),
        '2. 进展判断｜共记录 ' + items.length + ' 项工作，完成 ' + done + ' 项；' + (progressText || '各项目按计划推进。') + '。',
        '3. 行动优先级｜' + (priorityPlans.length ? priorityPlans.join('；') : pending.length ? pending[0] : '下一周期请明确一项可验证的交付目标，并围绕其持续推进。'), '',
        '数据看板｜页面上方展示投入小时、完成事项、涉及项目；下方“项目投入可视化”呈现各项目时长占比。', '',
        '二、成果展示｜把投入转化为可证明的结果', '',
        ...(coreInsights.flatMap((item) => [
          item.headline,
          '成果：已完成 ' + item.completed + '/' + item.total + ' 项，平均进度 ' + item.averageProgress + '%' + (item.results.length ? '；' + joinReportPoints(item.results) + '。' : '；本期以关键事项推进与交付准备为主。'),
          item.unresolved.length ? '需注意：' + joinReportPoints(item.unresolved) + '。' : '结果判断：当前项目推进节奏稳定，可继续以阶段交付为牵引。', ''
        ])),
        otherProjects.length ? '其他项目｜【' + otherProjects.join('】【') + '】已按既定事项推进，详见页面的工作明细与项目投入图。' : '',
        '三、复盘与成长｜用 STAR-L 说明“怎么做到”与“学会了什么”', '',
        ...(coreInsights.flatMap((item) => [
          item.headline,
          'S｜情境：' + (item.situations[0] || '围绕该项目的阶段目标，需要在有限周期内推动关键事项。'),
          'T｜任务：' + (item.tasks.length ? joinReportPoints(item.tasks) : '完成本期已登记的项目推进与协同事项。'),
          'A｜行动：' + (item.actions.length ? joinReportPoints(item.actions) + '。' : '通过拆分任务、推进协同并持续记录结果，推动事项向前。'),
          'R｜结果：已完成 ' + item.completed + '/' + item.total + ' 项，平均进度 ' + item.averageProgress + '%' + (item.results.length ? '；形成 ' + joinReportPoints(item.results) + '。' : '。'),
          'L｜学习：' + item.learning, ''
        ])),
        '四、未来规划｜以明确优先级推动下一阶段闭环', '',
        priorityPlans.length ? priorityPlans.map((item, index) => String(index + 1) + '. 优先推进｜' + item).join('\n') : '1. 优先推进｜结合当前项目进度，明确下一项可验证的交付目标。',
        pending.length ? '\n待解决与待完成事项：\n' + pending.map((item, index) => String(index + 1) + '. ' + item).join('\n') : '\n待解决与待完成事项：暂无明确待办，建议提前补充下一周期任务。',
        resolved.length ? '\n已完成闭环：\n' + resolved.slice(0, 5).map((item, index) => String(index + 1) + '. ' + item).join('\n') : '',
        '', '自身评价｜' + (pending.length ? '整体推进符合预期。下一阶段应聚焦少量关键交付，持续把待解决事项转化为明确行动，并复盘有效方法。' : '整体推进符合预期。已形成以结果为导向的工作节奏，后续继续沉淀可复用的方法与决策。')
      ];
      return { total, done, projects: projects.length, projectHours: timeStats.projectHours, text: lines.filter((line, index, array) => line !== '' || index === 0 || array[index - 1] !== '').join('\n') };
    }
    function buildWeeklyReport(items, range) {
      const timeStats = timeStatsFor(items);
      const total = timeStats.total;
      const done = items.filter((item) => Number(item.progress) >= 100).length;
      const projects = [...new Set(items.map((item) => item.project).filter(Boolean))];
      const resolved = resolvedLines(items, range, true);
      const pending = pendingLines(items, true);
      const plans = nextPlanLines(items, true);
      const collaboration = collaborationLines(items, true);
      const summary = items.length ? [
        '本周覆盖 ' + new Set(items.map((item) => item.workDate)).size + ' 个工作日、' + projects.length + ' 个项目，实际投入 ' + total.toFixed(1) + ' 小时，完成 ' + done + '/' + items.length + ' 项工作。',
        ...projectProgressLines(items, timeStats.projectHours, true),
        resolved.length ? '已解决事项：' + joinReportPoints(resolved) + '。' : '已解决事项：本周未单独登记已解决问题。',
        pending.length ? '待解决事项：' + joinReportPoints(pending) + '。' : '待解决事项：暂无明确待解决事项。'
      ] : ['本周暂无工作记录，尚未形成可汇总的项目成果、进展或问题闭环。'];
      const nextPlan = plans.length
        ? plans.map((item, index) => String(index + 1) + '. ' + item)
        : ['1. 未来一周明确一项可验证的交付目标，并结合月度目标拆解后续行动。'];
      const selfEvaluation = items.length
        ? pending.length
          ? '本周已形成阶段成果并持续推进重点项目；下一阶段需优先闭环待解决事项，并以一周到一个月的视角管理交付节奏。'
          : '本周整体推进符合预期，项目成果与问题闭环较为清晰；后续继续围绕月度目标沉淀方法并推进可验证交付。'
        : '本周暂无可复盘记录；建议从下一项工作开始补充成果、问题和下一步计划。';
      const lines = [
        '周报',
        '*本周工作总结：',
        ...summary,
        '*下一步工作计划：（最低考虑一周，建议“月”级别）',
        ...nextPlan,
        '团队沟通：',
        ...(collaboration.length ? collaboration : ['-']),
        '附件',
        '',
        '*自身评价：',
        selfEvaluation,
        '备注',
        '-'
      ];
      return { total, done, projects: projects.length, projectHours: timeStats.projectHours, text: lines.join('\n') };
    }
    function reportFor(items, range) {
      return mode === 'week' ? buildWeeklyReport(items, range) : buildStructuredReport(items, range, summaryHeading(mode), true);
    }
    function renderProjectShare(container, projectHours, total, emptyText, totalLabel) {
      const entries = Object.entries(projectHours).sort((a, b) => b[1] - a[1]);
      const colors = ['#0071e3', '#5856d6', '#ff9f0a', '#34c759', '#ff375f', '#64d2ff'];
      if (!entries.length || !total) {
        container.innerHTML = '<div class="empty" style="grid-column:1/-1">' + emptyText + '</div>';
        return;
      }
      let cursor = 0;
      const slices = entries.map((entry, index) => {
        const percentage = entry[1] / total * 100;
        const next = cursor + percentage;
        const slice = colors[index % colors.length] + ' ' + cursor + '% ' + next + '%';
        cursor = next;
        return slice;
      });
      const legend = entries.map((entry, index) => {
        const percentage = entry[1] / total * 100;
        return '<div class="legend-row"><span class="legend-dot" style="background:' + colors[index % colors.length] + '"></span><span class="legend-name">' + escapeHtml(entry[0]) + '</span><span class="legend-value">' + entry[1].toFixed(1) + 'h · ' + percentage.toFixed(0) + '%</span></div>';
      }).join('');
      container.innerHTML = '<div class="donut" style="background:conic-gradient(' + slices.join(',') + ')"><span><b>' + total.toFixed(1) + 'h</b>' + totalLabel + '</span></div><div class="legend">' + legend + '</div>';
    }
    function dashboardSnapshot(currentMode) {
      const range = currentMode === 'day' ? { start: today(), end: today() } : rangeFor(currentMode, today());
      const items = recordsInRange(logs, range);
      const timeStats = timeStatsFor(items);
      const plannedItems = items.filter((item) => String(item.nextStep || '').trim());
      const completedItems = items.filter((item) => Number(item.progress) >= 100);
      const averageProgress = items.length ? Math.round(items.reduce((total, item) => total + Math.max(0, Math.min(100, Number(item.progress) || 0)), 0) / items.length) : 0;
      return {
        range,
        items,
        timeStats,
        plannedItems,
        completedItems,
        averageProgress,
        planCoverage: items.length ? Math.round(plannedItems.length / items.length * 100) : 0
      };
    }
    function dashboardPeriodCard(title, snapshot) {
      const preview = snapshot.plannedItems.slice(0, 2).map((item) => escapeHtml(item.nextStep)).join('；');
      const planText = preview || '尚未填写下一步计划。';
      return '<article class="analysis-card"><div class="analysis-card-head"><div><h3>' + title + '</h3><span>' + snapshot.range.start + ' 至 ' + snapshot.range.end + '</span></div><span>' + snapshot.items.length + ' 项记录</span></div><div class="analysis-total"><div><b>' + snapshot.timeStats.total.toFixed(1) + 'h</b><span>实际投入时长</span></div><span>完成 ' + snapshot.completedItems.length + ' / ' + snapshot.items.length + '</span></div><div><div class="analysis-bar-label"><span>平均进度</span><b>' + snapshot.averageProgress + '%</b></div><div class="analysis-bar"><span style="width:' + snapshot.averageProgress + '%"></span></div></div><div><div class="analysis-bar-label"><span>计划覆盖</span><b>' + snapshot.planCoverage + '%</b></div><div class="analysis-bar plan"><span style="width:' + snapshot.planCoverage + '%"></span></div></div><p class="analysis-plan"><b>下一步：</b>' + planText + '</p></article>';
    }
    function renderDashboard() {
      const daily = dashboardSnapshot('day');
      const weekly = dashboardSnapshot('week');
      const monthly = dashboardSnapshot('month');
      const yearly = dashboardSnapshot('year');
      get('dashboard-today-hours').textContent = daily.timeStats.total.toFixed(1) + 'h';
      get('dashboard-week-hours').textContent = weekly.timeStats.total.toFixed(1) + 'h';
      get('dashboard-month-hours').textContent = monthly.timeStats.total.toFixed(1) + 'h';
      get('dashboard-year-hours').textContent = yearly.timeStats.total.toFixed(1) + 'h';
      renderProjectShare(get('dashboard-today-share'), daily.timeStats.projectHours, daily.timeStats.total, '今天还没有工作记录。登记一项工作后，这里会生成项目投入占比。', '今日总时长');
      const leadingProject = Object.entries(daily.timeStats.projectHours).sort((a, b) => b[1] - a[1])[0];
      get('dashboard-today-insights').innerHTML = '<div class="dashboard-insight"><span>已记录任务</span><b>' + daily.items.length + ' 项</b></div><div class="dashboard-insight"><span>平均进度</span><b>' + daily.averageProgress + '%</b></div><div class="dashboard-insight"><span>下一步计划覆盖</span><b>' + daily.planCoverage + '%</b></div><div class="dashboard-insight"><span>投入最多项目</span><b>' + (leadingProject ? escapeHtml(leadingProject[0]) + ' · ' + leadingProject[1].toFixed(1) + 'h' : '暂无') + '</b></div>';
      get('dashboard-periods').innerHTML = dashboardPeriodCard('本周工作进度与计划', weekly) + dashboardPeriodCard('本月工作进度与计划', monthly) + dashboardPeriodCard('年度工作进度与计划', yearly);
    }
    function dailyReportFor(items, selectedDate) {
      const dateTitle = new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'long', day:'numeric', weekday:'long' }).format(new Date(selectedDate + 'T12:00:00'));
      return buildStructuredReport(items, { start: selectedDate, end: selectedDate }, dateTitle + '工作报告：');
    }
    function renderDailyReport() {
      const selectedDate = get('daily-date').value || today();
      const items = recordsInRange(logs, {start:selectedDate,end:selectedDate}).sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
      const report = dailyReportFor(items, selectedDate);
      get('daily-hours-total').textContent = report.total.toFixed(1);
      get('daily-done-total').textContent = report.done;
      get('daily-project-total').textContent = report.projects;
      const override = reportOverrides[reportOverrideKey('day',selectedDate,selectedDate)];
      if (!dailyReportEditing) get('daily-report-text').value = override?.text ?? report.text;
      get('restore-daily-report').hidden = !override;
      renderProjectShare(get('daily-project-share'), report.projectHours, report.total, '选择日期后，这里会生成当日各项目的工时占比图。', '本日总时长');
      const list = get('daily-work-list');
      if (!items.length) {
        list.innerHTML = '<div class="empty">该日期暂无工作记录。<br>可选择其他日期，或先登记当天工作。</div>';
        return;
      }
      const grouped = {};
      items.forEach((item) => { const project = item.project || '未归类项目'; (grouped[project] ||= []).push(item); });
      list.innerHTML = Object.entries(grouped).map(([project, projectItems]) => {
        const projectHours = timeStatsFor(projectItems).total;
        const taskList = projectItems.map((item) =>
          '<article class="daily-log"><h3>' + escapeHtml(item.title) + '</h3><p>' + escapeHtml(item.startTime || '--:--') + '–' + escapeHtml(item.endTime || '--:--') + '　' + Number(item.hours).toFixed(1) + ' 小时　·　' + escapeHtml(item.category) + '</p>' + (item.meetingContent ? '<p>会议内容：' + escapeHtml(item.meetingContent) + '</p>' : '') + (item.outcome ? '<p>产出：' + escapeHtml(item.outcome) + '</p>' : '') + '</article>'
        ).join('');
        return '<section class="daily-project-group"><div class="daily-project-title"><strong>' + escapeHtml(project) + '</strong><span>' + projectItems.length + ' 项工作 · ' + projectHours.toFixed(1) + ' 小时</span></div>' + taskList + '</section>';
      }).join('');
    }
    function syncPeriodReportHeight() {
      const textarea = get('report-text');
      textarea.style.height = 'auto';
      textarea.style.height = Math.max(250, Number(textarea.scrollHeight) || 0) + 'px';
    }
    function render() {
      const range = rangeFor(mode, get('anchor-date').value);
      const items = selectedLogs();
      const report = reportFor(items, range);
      renderProjectHistory();
      get('report-title').textContent = modeName(mode);
      get('report-range').textContent = range.start + ' 至 ' + range.end;
      get('hours-total').textContent = report.total.toFixed(1);
      get('done-total').textContent = report.done;
      get('project-total').textContent = report.projects;
      const override = reportOverrides[reportOverrideKey(mode,range.start,range.end)];
      if (!periodReportEditing) get('report-text').value = override?.text ?? report.text;
      get('restore-period-report').hidden = !override;
      syncPeriodReportHeight();
      get('log-count').textContent = logs.length + ' 条记录';
      const list = get('log-list');
      if (!logs.length) {
        list.innerHTML = '<div class="empty">✦ 从第一条工作记录开始<br>填写上方表单后，周度、月度和年度总结都会自动出现。</div>';
      } else {
        list.innerHTML = logs.slice().sort((a,b) => b.workDate.localeCompare(a.workDate) || b.id - a.id).slice(0, 8).map((item) =>
          '<article class="log"><div class="date">' + prettyDate(item.workDate) + '</div><div><div class="title-row"><h3>' + escapeHtml(item.title) + '</h3><span class="tag">' + escapeHtml(item.category) + '</span></div><p class="meta">' + escapeHtml(item.project || '未归类项目') + '　' + Number(item.hours).toFixed(1) + ' 小时' + (item.startTime ? '　' + item.startTime + '–' + item.endTime : '') + '</p>' + (item.outcome ? '<p class="outcome">产出：' + escapeHtml(item.outcome) + '</p>' : '') + (item.painPoint ? '<p class="outcome">痛点（' + escapeHtml(item.painStatus) + '）：' + escapeHtml(item.painPoint) + '</p>' : '') + (item.painSolution ? '<p class="outcome">解决方案：' + escapeHtml(item.painSolution) + '</p>' : '') + '</div><div class="record-actions"><div class="progress">' + item.progress + '%</div><button class="edit" data-edit="' + item.id + '">编辑</button><button class="delete" data-delete="' + item.id + '">删除</button></div></article>'
        ).join('');
      }
      renderProjectShare(get('period-project-share'), report.projectHours, report.total, '选择周期后，这里会生成各项目的工时占比图。', '本期总时长');
      renderDailyReport();
      renderDashboard();
      renderPendingTasks();
      renderTaskCenter();
    }
    function setReportEditing(type, editing) {
      const isPeriod = type === 'period';
      const textarea = get(isPeriod ? 'report-text' : 'daily-report-text');
      const button = get(isPeriod ? 'toggle-period-report' : 'toggle-daily-report');
      if (isPeriod) periodReportEditing = editing; else dailyReportEditing = editing;
      textarea.readOnly = !editing;
      button.textContent = editing ? '完成编辑' : '编辑报告';
      button.classList.toggle('editing', editing);
      if (isPeriod) syncPeriodReportHeight();
      if (editing) textarea.focus();
    }
    function resetReportEditors() {
      setReportEditing('period', false);
      setReportEditing('daily', false);
    }
    function reportScope(type) {
      const kind=type==='daily'?'day':mode;
      const range=kind==='day'?{start:get('daily-date').value||today(),end:get('daily-date').value||today()}:rangeFor(mode,get('anchor-date').value);
      return {kind,...range,key:reportOverrideKey(kind,range.start,range.end)};
    }
    async function persistReport(type,text,source,expectedReport=null) {
      const scope=reportScope(type),profileId=activeProfileId,workspaceId=workbench.controller.getWorkspace().workspaceId;
      try {
        await workbench.flushLegacy();
        if(workbench.controller.getWorkspace().workspaceId!==workspaceId||activeProfileId!==profileId||reportScope(type).key!==scope.key)throw Error('数据来源或报告范围已变化，请重试');
        await workbench.controller.commit(w=>{
          const profile=w.profiles.find(p=>p.id===profileId);
          if(!profile)throw Error('当前用户已变化');
          if(expectedReport&&JSON.stringify(aiReportProjection(profile,scope.kind,scope.start,scope.end))!==JSON.stringify(expectedReport))throw Error('工作记录已变化，请重新预览');
          profile.reportOverrides ||= {};
          if(text===null)delete profile.reportOverrides[scope.key];
          else profile.reportOverrides[scope.key]={text,source,savedAt:new Date().toISOString()};
          return w;
        });
        workbench.sync();
        return true;
      } catch(error){toast('报告未保存：'+error.message);return false;}
    }
    async function finishReportEditing(type) {
      const value=get(type==='period'?'report-text':'daily-report-text').value;
      if(await persistReport(type,value,'manual')){setReportEditing(type,false);render();toast('本期报告已保存。');}
    }
    const aiLocal=location.protocol==='http:'&&location.hostname==='127.0.0.1'&&location.port==='4173';
    let aiToken='',aiConnected=false,aiPoll=null,aiRequestId=0,aiDraftScope=null,aiAbortController=null;
    function cancelAiReport(){
      aiRequestId++;
      aiAbortController?.abort();aiAbortController=null;
      aiDraftScope=null;
      if(get('ai-report-dialog').open)get('ai-report-dialog').close();
    }
    function aiScope(type){
      const w=workbench.controller.getWorkspace(),scope=reportScope(type),profile=w.profiles.find(p=>p.id===w.activeProfileId);
      return {...scope,profileId:w.activeProfileId,workspaceId:w.workspaceId,report:aiReportProjection(profile,scope.kind,scope.start,scope.end)};
    }
    function sameAiScope(snapshot,type){
      const now=aiScope(type);
      return now.workspaceId===snapshot.workspaceId&&now.profileId===snapshot.profileId&&now.key===snapshot.key&&JSON.stringify(now.report)===JSON.stringify(snapshot.report);
    }
    function estimateAiBatches(items){
      const encoder=new TextEncoder();let batches=0,current=[];
      for(const item of items){
        const next=[...current,item];
        if(current.length&&(next.length>100||encoder.encode(JSON.stringify(next)).byteLength>64*1024)){
          batches++;current=[item];
        }else current=next;
      }
      return batches+(current.length||!batches?1:0);
    }
    function formatAiPreview(report){
      if(!report.items.length)return '本期没有已保存记录。';
      return report.items.map((item,index)=>[
        (index+1)+'. '+item.workDate+' · '+item.title,
        '项目：'+item.project+'　时长：'+item.hours+' 小时　进度：'+item.progress+'%',
        '产出：'+item.outcome,
        '下一步：'+item.nextStep
      ].join('\n')).join('\n\n');
    }
    function aiGenerationErrorMessage(error){
      return '生成失败：'+error.message+((error.code==='AI_RATE_LIMIT'||error.status===429)?'。当前额度或请求频率受限，请稍后重试并检查 ChatGPT 账户额度。':'');
    }
    async function aiApi(path,body,guard=()=>true,signal){
      if(!aiToken){
        const session=await fetch('/api/ai/session',{headers:{'X-Workbench-Request':'1'},cache:'no-store',signal});
        if(!session.ok)throw Error('无法建立本机授权会话');
        aiToken=(await session.json()).token;
      }
      if(!guard())throw Error('工作记录或报告范围已变化，请重新预览');
      const response=await fetch('/api/ai/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Workbench-Request':'1','X-Workbench-Token':aiToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){const error=Error(result.error||'ChatGPT 请求失败');error.code=result.code||'';error.status=response.status;throw error;}
      return result;
    }
    function showAiStatus(status){
      aiConnected=!!status.connected;
      get('ai-account-status').textContent=aiConnected?'已连接'+(status.accountLabel?' · '+status.accountLabel:'')+(status.model?' · '+status.model:''):'未连接 ChatGPT。连接后可在报告页面生成草稿。';
      get('ai-connect').hidden=aiConnected;
      get('ai-disconnect').hidden=!aiConnected;
      get('ai-period-report').hidden=!aiConnected;
      get('ai-daily-report').hidden=!aiConnected;
    }
    async function refreshAiStatus(){try{showAiStatus(await aiApi('status'));}catch(error){showAiStatus({connected:false});get('ai-account-status').textContent='连接状态暂不可用：'+error.message;}}
    function openAiReport(type){
      if(!aiConnected)return toast('请先在用户与数据管理中连接 ChatGPT。');
      cancelAiReport();
      const scope=aiScope(type);
      aiDraftScope={...scope,type};
      const label={day:'本日',week:'本周',month:'本月',year:'本年'}[scope.kind];
      get('ai-report-dialog-title').textContent='AI 辅助生成'+label+'报告';
      get('ai-report-scope').textContent=scope.start+' 至 '+scope.end+' · '+scope.report.recordCount+' 条已保存记录。确认后才会发送下方内容。';
      const batches=estimateAiBatches(scope.report.items);
      get('ai-report-batches').textContent=batches>1?'预计分为约 '+batches+' 批处理，并在最后合成草稿；通常需要约 '+(batches+1)+' 次模型调用。':'预计 1 次模型调用。';
      get('ai-report-preview').textContent=formatAiPreview(scope.report);
      get('ai-report-state').textContent='';get('ai-draft-label').hidden=true;get('ai-report-draft').value='';get('ai-report-save').hidden=true;get('ai-report-generate').hidden=false;get('ai-report-generate').disabled=!scope.report.recordCount;
      get('ai-report-dialog').showModal();
    }
    function persistData() {
      window.appStorage.setItem(profileDataKey(activeProfileId), JSON.stringify(logs));
      window.appStorage.setItem(profileTasksKey(activeProfileId), JSON.stringify(tasks));
    }
    function save() {
      persistData();
      render();
      renderProfiles();
    }
    function toast(message) {
      if (workbench.delayToast(message)) return;
      const node = get('toast');
      node.textContent = message;
      node.classList.add('show');
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
    }
    function normalizeImportedRecords(value) {
      if (!Array.isArray(value)) throw new Error('备份文件中没有可恢复的工作记录。');
      const usedIds = new Set();
      return value.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error('备份文件格式不正确。');
        let id = Number(item.id);
        if (!Number.isSafeInteger(id) || usedIds.has(id)) id = Date.now() + index;
        usedIds.add(id);
        const startTime = /^\d{2}:\d{2}$/.test(String(item.startTime || '')) ? String(item.startTime) : '09:00';
        const endTime = /^\d{2}:\d{2}$/.test(String(item.endTime || '')) ? String(item.endTime) : '10:00';
        const importedHours = Number(item.hours);
        const timeSegments=Array.isArray(item.timeSegments)?splitTimeSegments(item.timeSegments):null;
        const hours = timeSegments ? segmentHours(timeSegments) : importedHours > 0 && importedHours <= 24 ? importedHours : durationHours(startTime, endTime);
        return {
          id,
          ...(timeSegments ? {timeSegments} : {}),
          workDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.workDate || '')) ? String(item.workDate) : today(),
          title: String(item.title || '未命名工作').slice(0, 200),
          project: String(item.project || '').slice(0, 120),
          category: normalizeCategory(item.category),
          hours,
          progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
          startTime,
          endTime,
          outcome: String(item.outcome || '').slice(0, 5000),
          nextStep: String(item.nextStep || '').slice(0, 5000),
          painPoint: String(item.painPoint || '').slice(0, 5000),
          painSolution: String(item.painSolution || '').slice(0, 5000),
          painStatus: item.painStatus === '未解决' ? '未解决' : '已解决',
          painResponse: String(item.painResponse || '').slice(0, 5000),
          meetingContent: String(item.meetingContent || '').slice(0, 5000)
        };
      });
    }
    function exportBackup() {
      const profile = currentProfile();
      const backup = makeProfileBackup({ ...profile, records: logs, tasks });
      const fileSafeName = profile.name.replace(/[\\/:*?"<>|]/g, '_');
      downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }), '节拍数据备份-' + fileSafeName + '-' + today() + '.json');
      toast('已导出当前用户备份，可复制到新电脑后导入。');
    }
    function importBackup(file) {
      if (!file) return;
      const importWorkspaceId = workbench.controller.getWorkspace().workspaceId;
      const importProfileId = activeProfileId;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const backup = JSON.parse(String(reader.result || ''));
          const parsed = parseProfileBackup(backup);
          const avatar = await validateAvatar(parsed.avatar);
          if (workbench.controller.getWorkspace().workspaceId !== importWorkspaceId || activeProfileId !== importProfileId) throw Error('导入期间数据来源已变化，请重试');
          if (flowStartedAt || meetingStartedAt || taskTracking || meetingDraft) throw Error('请先结束计时');
          const records = normalizeImportedRecords(parsed.records);
          const importedTasks = normalizeTasks(parsed.tasks);
          const sourceName = !Array.isArray(backup) && backup.profile && backup.profile.name ? backup.profile.name : file.name.replace(/\.json$/i, '');
      const profile = { id: 'user-' + Date.now() + '-' + Math.random().toString(16).slice(2), name: uniqueProfileName(sourceName), avatar, reportOverrides: parsed.reportOverrides || {} };
          profiles.push(profile);
          activeProfileId = profile.id;
          logs = records;
          tasks = importedTasks;
          reportOverrides = profile.reportOverrides;
          resetReportEditors();
          window.appStorage.setItem(profileDataKey(activeProfileId), JSON.stringify(logs));
          window.appStorage.setItem(profileTasksKey(activeProfileId), JSON.stringify(tasks));
          persistProfiles();
          get('new-profile-name').value = '';
          get('import-data').value = '';
          resetWorkForm();
          render();
          renderProfiles();
          toast('已恢复 ' + records.length + ' 条记录到“' + profile.name + '”。');
        } catch (error) {
          get('import-data').value = '';
          toast('导入失败：请选择从节拍工作台导出的备份文件。');
        }
      };
      reader.readAsText(file, 'utf-8');
    }
    function resetWorkForm() {
      editingId = null;
      get('work-form').reset();
      get('work-date').value = today();
      get('start-time').value = '09:00';
      get('end-time').value = '10:00';
      get('progress').value = '100';
      get('pain-point').value = '';
      get('pain-solution').value = '';
      get('pain-response').value = '';
      document.querySelector('input[name="pain-status"][value="已解决"]').checked = true;
      get('form-heading').textContent = '✦ 登记一项工作';
      get('form-subtitle').textContent = '一条记录，自动进入周度、月度和年度总结。';
      get('form-mode').textContent = '快速录入';
      get('save-work').textContent = '＋ 保存工作记录';
      get('cancel-edit').hidden = true;
      updateDurationPreview();
      renderPendingTasks();
    }
    function editLog(id) {
      const item = logs.find((entry) => entry.id === id);
      if (!item) return;
      editingId = id;
      get('work-date').value = item.workDate;
      get('title').value = item.title || '';
      get('project').value = item.project || '';
      get('category').value = normalizeCategory(item.category);
      get('start-time').value = item.startTime || '09:00';
      get('end-time').value = item.endTime || timeAfter('09:00', Number(item.hours) || 1);
      get('progress').value = item.progress;
      get('outcome').value = item.outcome || '';
      get('next-step').value = item.nextStep || '';
      get('pain-point').value = item.painPoint || '';
      get('pain-solution').value = item.painSolution || '';
      get('pain-response').value = item.painResponse || '';
      document.querySelector('input[name="pain-status"][value="' + (item.painStatus === '未解决' ? '未解决' : '已解决') + '"]').checked = true;
      get('form-heading').textContent = '✎ 编辑工作记录';
      get('form-subtitle').textContent = '修改并保存后，所有总结和时长占比会即时更新。';
      get('form-mode').textContent = '编辑中';
      get('save-work').textContent = '保存修改';
      get('cancel-edit').hidden = false;
      updateDurationPreview();
      renderPendingTasks();
      switchFeaturePanel('work-entry', true);
      get('work-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    get('work-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const hours = durationHours(get('start-time').value, get('end-time').value);
      const progress = Number(get('progress').value);
      if (hours <= 0 || hours > 24 || progress < 0 || progress > 100) { toast('请检查起止时间和进度。'); return; }
      const existingRecord = editingId ? logs.find((item) => item.id === editingId) : null;
      let record = {
        id: editingId || Date.now(),
        workDate: get('work-date').value,
        title: get('title').value.trim(),
        project: get('project').value.trim(),
        category: get('category').value,
        hours, progress,
        startTime: get('start-time').value,
        endTime: get('end-time').value,
        outcome: get('outcome').value.trim(),
        nextStep: get('next-step').value.trim(),
        meetingContent: existingRecord && existingRecord.meetingContent ? existingRecord.meetingContent : '',
        painPoint: get('pain-point').value.trim(),
        painSolution: get('pain-solution').value.trim(),
        painStatus: document.querySelector('input[name="pain-status"]:checked').value,
        painResponse: get('pain-response').value.trim()
      };
      try { record=preserveSegmentedTiming(existingRecord,record); } catch(e) { toast(e.message);return; }
      if (editingId) {
        logs = logs.map((item) => item.id === editingId ? record : item);
      } else {
        logs.push(record);
      }
      const wasEditing = Boolean(editingId);
      resetWorkForm();
      save();
      toast(wasEditing ? '修改已保存，相关总结已同步更新。' : '已记录，这条工作会自动计入相应报告。');
    });
    get('start-time').addEventListener('change', updateDurationPreview);
    get('end-time').addEventListener('change', updateDurationPreview);
    function timeString(date) {
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }
    function clearFlowTimer() {
      if (flowTimer) window.clearInterval(flowTimer);
      flowTimer = null;
    }
    function updateFlowControls() {
      const timer = get('flow-timer');
      if (!flowStartedAt) {
        timer.textContent = '00:00:00';
        return;
      }
      timer.textContent = formatMeetingElapsed(Date.now() - flowStartedAt.getTime());
    }
    async function startFlowMode() {
      switchFeaturePanel('flow-mode',true);updateFlowStartControls();updateFlowControls();
      if(flowStartedAt||flowStartBusy||flowFinishBusy)return;
      await startSelectedFlow();
    }
    async function startFlowFromProjectSelection(){
      syncFlowProjectTasks();
      if(!flowStartedAt||flowFinishBusy)return;
      try{await updateDurableFlowProject(workbench.controller,sessionIds.flow,get('flow-project').value);get('flow-save-state').textContent='所属项目已保存，起点与计时保持不变。';workbench.sync();}
      catch(e){get('flow-save-state').textContent='项目尚未保存，请重试或导出。'+e.message;}
      updateFlowStartControls();
    }
    function updateFlowStartControls(){
      const button=get('start-flow-session');button.hidden=false;
      button.disabled=flowStartBusy||flowFinishBusy;
      button.textContent=flowStartBusy?'正在保存开始时间…':flowFinishBusy?'正在保存工作记录…':flowStartedAt?(flowFinishIntent?'重试保存':'完成并保存'):(flowStartIntent?'重试开始':'开始心流');
      get('flow-project').disabled=flowStartBusy||flowFinishBusy||(!flowStartedAt&&!!flowStartIntent);
      get('flow-live-label').textContent=flowStartedAt?'正在计时：'+(get('flow-project').value.trim()||'未选择项目'):'尚未开始';
    }
    async function startSelectedFlow(){
      if(flowStartBusy||flowStartedAt)return;
      const startingEpoch=flowPageEpoch;
      try{
        const w=workbench.controller.getWorkspace();
        if(!flowStartIntent)flowStartIntent=createFlowStartIntent(w.workspaceId,activeProfileId,get('flow-project').value,Date.now());
        flowStartBusy=true;updateFlowStartControls();get('flow-save-state').textContent='正在保存开始时间…';
        const session=await startDurableFlow(workbench.controller,flowStartIntent,{category:get('flow-category').value,tasks:flowDraftTasks});
        if(startingEpoch!==flowPageEpoch){flowStartIntent=null;workbench.sync();get('flow-save-state').textContent='检测到页面退出，将按最后成功检查点自动保存。';return;}
        sessionIds.flow=session.id;sessionRuns.flow={start:flowStartTime(session),prior:[]};flowStartedAt=new Date(flowStartTime(session));clearFlowTimer();flowTimer=window.setInterval(updateFlowControls,1000);
        workbench.sync();get('flow-save-state').textContent=(workbench.temporary?'临时会话：关闭后无法保证恢复。':'开始时间已保存。')+' '+formatFlowTimestamp(flowStartTime(session));updateFlowControls();
      }catch(e){get('flow-save-state').textContent='开始时间未保存，心流尚未启动。'+e.message;}
      finally{flowStartBusy=false;updateFlowStartControls();}
    }
    async function completePersistedFlow(){
      if(flowFinishBusy)return 'saving';
      if(!get('flow-project').value.trim()){get('flow-save-state').textContent='请补选所属项目，已计时间仍保留。';get('flow-project').focus();return 'missing-project';}
      try{
        if(!flowFinishIntent){const endAt=Date.now();sessionRuns.flow.end=endAt;const taskList=taskSummary(flowDraftTasks);flowFinishIntent={endAt,now:endAt,segments:sessionSnapshot('flow').draft.segments,recordDraft:{title:flowTaskTitle(taskList),category:get('flow-category').value,outcome:taskList?'心流完成任务：\n'+taskList:'已完成一次心流专注工作。'},draftTasks:structuredClone(flowDraftTasks)};clearFlowTimer();}
        flowFinishBusy=true;updateFlowStartControls();get('flow-save-state').textContent='正在保存工作记录…';
        await settleDurableFlow(workbench.controller,sessionIds.flow,{...flowFinishIntent,project:get('flow-project').value});
        delete sessionIds.flow;delete sessionRuns.flow;flowStartedAt=null;flowStartIntent=null;flowFinishIntent=null;flowDraftTasks=[];get('flow-form').reset();workbench.sync();renderDraftTasks('flow');updateFlowControls();get('flow-save-state').textContent='心流工作已保存。';switchFeaturePanel('work-records',true);toast('心流工作已完成并保存。');return 'saved';
      }catch(e){get('flow-save-state').textContent='记录尚未保存，请重试或打开保存状态导出副本。'+e.message;if(!workbench.controller.getPending()){flowFinishIntent=null;if(sessionRuns.flow)delete sessionRuns.flow.end;clearFlowTimer();flowTimer=window.setInterval(updateFlowControls,1000);}return 'save-failed';}
      finally{flowFinishBusy=false;updateFlowStartControls();}
    }
    function flowTaskTitle(taskList) {
      const firstTask = String(taskList || '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || '心流工作';
      return ('心流：' + firstTask.replace(/^[-•●\d.、\s]+/, '')).slice(0, 120);
    }
    function completeFlow({ background = false } = {}) {
      if (!flowStartedAt) return 'inactive';
      const project = get('flow-project').value.trim();
      if (!project) return 'missing-project';
      const durable=workbench.controller.getWorkspace().sessions.find(s=>s.id===sessionIds.flow&&['confirm-end','checkpoint-end'].includes(s.draft.recoveryPolicy));
      if(durable)return completePersistedFlow();
      const startedAt = flowStartedAt;
      const endedAt = new Date();
      const elapsedHours = (endedAt.getTime() - startedAt.getTime()) / 3600000;
      if (!Number.isFinite(elapsedHours) || !(elapsedHours > 0)) return 'invalid-duration';
      const taskList = taskSummary(flowDraftTasks);
      let startTime = timeString(startedAt);
      let endTime = timeString(endedAt);
      if (startTime === endTime && elapsedHours < 1 / 60) endTime = timeAfter(startTime, 1 / 60);
      const record = {
        id: Date.now(),
        workDate: dateKey(startedAt),
        title: flowTaskTitle(taskList),
        project,
        category: get('flow-category').value,
        hours: elapsedHours,
        timeSegments: splitTimeSegments([{start:startedAt.getTime(),end:endedAt.getTime()}]),
        startTime,
        endTime,
        progress: 100,
        outcome: taskList ? '心流完成任务：\n' + taskList : '已完成一次心流专注工作。',
        nextStep: '',
        meetingContent: '',
        painPoint: '',
        painSolution: '',
        painStatus: '已解决',
        painResponse: ''
      };
      applySessionRecord(record, 'flow');
      logs.push(record);
      addPersistentTasks(project, flowDraftTasks.filter((task) => !task.sourceTaskId), '心流模式');
      flowStartedAt = null;
      clearFlowTimer();
      flowDraftTasks = [];
      if (background) {
        persistData();
        return 'saved';
      }
      get('flow-form').reset();
      renderDraftTasks('flow');
      updateFlowControls();
      save();
      switchFeaturePanel('work-records', true);
      toast('心流工作已完成并记录，已自动计入项目与工作总结。');
      return 'saved';
    }
    get('flow-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if(!flowStartedAt){await startSelectedFlow();return;}
      const result = await completeFlow();
      if (result === 'inactive') toast('请重新进入心流模式后开始计时。');
      if (result === 'missing-project') toast('请填写本次心流所属项目。');
      if (result === 'invalid-duration') toast('本次心流计时异常，请检查系统时间后重试。');
    });
    function completeFlowOnPageExit(event) {
      if(event.type==='pagehide')flowPageEpoch++;
      if(sessionIds.flow){if(event.type==='pagehide'){clearFlowTimer();delete sessionIds.flow;delete sessionRuns.flow;flowStartedAt=null;flowStartIntent=null;flowFinishIntent=null;}return;}
      if (workbench.isDirectory()) return;
      if (event.type === 'pagehide' && event.persisted === true) return;
      completeFlow({ background: true });
      if(event.type==='beforeunload' && workbench.isPending()){event.preventDefault();event.returnValue='';}
    }
    window.addEventListener('beforeunload', completeFlowOnPageExit);
    window.addEventListener('pagehide', completeFlowOnPageExit);
    window.addEventListener('pageshow',resumeFlowPage);
    function resumeFlowPage(event){
      if(event.persisted){renderFlowRecovery();updateFlowStartControls();}
    }
    ['flow', 'meeting'].forEach((kind) => {
      get('add-' + kind + '-task').addEventListener('click', () => addDraftTask(kind));
      get(kind + '-task-input').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        addDraftTask(kind);
      });
      renderDraftTasks(kind);
    });
    document.addEventListener('click', (event) => {
      const draftButton = event.target.closest('[data-draft-action]');
      if (draftButton) {
        const kind = draftButton.dataset.draftKind;
        const index = Number(draftButton.dataset.draftIndex);
        const rows = draftTasksFor(kind).slice();
        if (!Number.isInteger(index) || !rows[index]) return;
        if (draftButton.dataset.draftAction === 'toggle') {
          if (kind === 'flow' && rows[index].sourceTaskId) {
            togglePersistentTask(rows[index].sourceTaskId);
            const sourceTask = tasks.find((task) => task.id === rows[index].sourceTaskId);
            rows[index].completed = sourceTask ? sourceTask.completed : true;
          } else {
            rows[index].completed = !rows[index].completed;
          }
        }
        if (draftButton.dataset.draftAction === 'remove' && !rows[index].sourceTaskId) rows.splice(index, 1);
        setDraftTasks(kind, rows);
        renderDraftTasks(kind);
        return;
      }
      const completionButton = event.target.closest('[data-toggle-task]');
      if (completionButton) {
        togglePersistentTask(completionButton.dataset.toggleTask);
        return;
      }
      const trackingButton = event.target.closest('[data-track-project]');
      if (trackingButton) startTaskTracking(trackingButton.dataset.trackProject);
    });
    get('project').addEventListener('input', renderPendingTasks);
    get('project').addEventListener('change', renderPendingTasks);
    get('flow-project').addEventListener('input',()=>{syncFlowProjectTasks();updateFlowStartControls();});
    get('flow-data-recovery').addEventListener('click',()=>get('open-data-dialog').click());
    get('flow-project').addEventListener('change', startFlowFromProjectSelection);
    get('task-center-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const project = get('task-center-project').value.trim();
      const taskText = get('task-center-task').value.trim();
      if (!project || !taskText) {
        toast('请填写所属项目和任务内容。');
        return;
      }
      addPersistentTasks(project, [{ text: taskText, completed: false }], '任务清单');
      get('task-center-task').value = '';
      save();
      toast('已为“' + project + '”新增一项待完成任务。');
    });
    function formatMeetingElapsed(milliseconds) {
      const seconds = Math.max(0, Math.floor(milliseconds / 1000));
      const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const remainder = String(seconds % 60).padStart(2, '0');
      return hours + ':' + minutes + ':' + remainder;
    }
    function updateMeetingControls() {
      const button = get('meeting-toggle');
      const status = get('meeting-status');
      const flowButton = get('flow-meeting-toggle');
      if (!meetingStartedAt) {
        button.textContent = '● 快速开会';
        button.classList.remove('running');
        flowButton.textContent = '● 快速会议';
        flowButton.classList.remove('running');
        status.innerHTML = '一键开始计时；结束后填写项目、会议内容、产出和任务清单。';
        return;
      }
      button.textContent = '■ 结束会议';
      button.classList.add('running');
      flowButton.textContent = '■ 结束会议';
      flowButton.classList.add('running');
      status.innerHTML = '<strong>会议进行中 · 已计时 ' + formatMeetingElapsed(Date.now() - meetingStartedAt.getTime()) + '</strong>开始时间：' + dateKey(meetingStartedAt) + ' ' + timeString(meetingStartedAt);
    }
    function clearMeetingTimer() {
      if (meetingTimer) window.clearInterval(meetingTimer);
      meetingTimer = null;
    }
    async function startMeeting() {
      meetingStartedAt = new Date();
      updateMeetingControls();
      clearMeetingTimer();
      meetingTimer = window.setInterval(updateMeetingControls, 1000);
      await beginSession('meeting');
      toast('已开始会议计时。结束后补充会议记录即可。');
    }
    function endMeeting() {
      const startedAt = meetingStartedAt;
      const endedAt = new Date();
      meetingStartedAt = null;
      if(sessionRuns.meeting)sessionRuns.meeting.end=endedAt.getTime();
      clearMeetingTimer();
      updateMeetingControls();
      if (!startedAt) return;
      const startTime = timeString(startedAt);
      let endTime = timeString(endedAt);
      const elapsedHours = Math.max(1 / 60, Math.min(24, (endedAt.getTime() - startedAt.getTime()) / 3600000));
      if (startTime === endTime && elapsedHours < 23.99) endTime = timeAfter(startTime, 1 / 60);
      meetingDraft = { workDate: dateKey(startedAt), startTime, endTime, hours: elapsedHours };
      get('meeting-project').value = (flowStartedAt && get('flow-project').value.trim()) || get('project').value.trim();
      if (!sessionRuns.meeting?.restored) {
        get('meeting-dialog-content').value = '';
        get('meeting-outcome').value = '';
        meetingDraftTasks = [];
      }
      renderDraftTasks('meeting');
      get('meeting-time-summary').textContent = '会议时间：' + meetingDraft.workDate + ' ' + startTime + '–' + endTime + '，已自动统计 ' + elapsedHours.toFixed(1) + ' 小时。';
      meetingDialog.showModal();
    }
    get('meeting-toggle').addEventListener('click', () => meetingStartedAt ? endMeeting() : startMeeting());
    get('flow-meeting-toggle').addEventListener('click', () => meetingStartedAt ? endMeeting() : startMeeting());
    get('cancel-meeting-record').addEventListener('click', async () => {
      await discardSession('meeting');
      meetingDraft = null;
      meetingDialog.close();
      toast('本次会议未写入工作记录。');
    });
    get('meeting-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!meetingDraft) {
        meetingDialog.close();
        toast('会议计时已失效，请重新开始会议。');
        return;
      }
      if (workbench.isPending() || workbench.controller.isWriting()) {
        toast('会议记录尚未保存：上一项数据仍在保存或待恢复。请稍候重试，或在数据管理中重试/导出。');
        return;
      }
      const content = get('meeting-dialog-content').value.trim();
      const outcome = get('meeting-outcome').value.trim();
      const taskList = taskSummary(meetingDraftTasks);
      const project = get('meeting-project').value.trim();
      const shouldSyncToFlow = Boolean(flowStartedAt && project && project === get('flow-project').value.trim());
      const record = {
        id: Date.now(),
        workDate: meetingDraft.workDate,
        title: ('会议：' + content.replace(/\s+/g, ' ')).slice(0, 120),
        project,
        category: '会议讨论',
        hours: meetingDraft.hours,
        startTime: meetingDraft.startTime,
        endTime: meetingDraft.endTime,
        progress: 100,
        outcome,
        nextStep: taskList,
        meetingContent: content,
        painPoint: '',
        painSolution: '',
        painStatus: '已解决',
        painResponse: ''
      };
      applySessionRecord(record, 'meeting');
      logs.push(record);
      addPersistentTasks(project, meetingDraftTasks, '快速会议');
      meetingDraft = null;
      meetingDialog.close();
      meetingDraftTasks = [];
      renderDraftTasks('meeting');
      save();
      if (shouldSyncToFlow) syncFlowProjectTasks();
      toast(shouldSyncToFlow ? '会议记录已保存，新增待完成任务已同步到心流任务清单。' : '会议记录已保存，并已计入当日工作统计。');
    });
    function datesForBackfill(startValue, endValue) {
      if (!startValue || !endValue || startValue > endValue) return [];
      const dates = [];
      const cursor = new Date(startValue + 'T12:00:00');
      const end = new Date(endValue + 'T12:00:00');
      while (cursor <= end) {
        dates.push(dateKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return dates;
    }
    function updateBackfillPreview() {
      const days = datesForBackfill(get('backfill-start-date').value, get('backfill-end-date').value);
      const hours = Number(get('backfill-hours').value);
      const preview = get('backfill-preview');
      if (!days.length) {
        preview.textContent = '请设置有效的开始日期和结束日期。';
        return;
      }
      if (!(hours > 0 && hours <= 24)) {
        preview.textContent = '请填写 0.1 至 24 小时的每日平均工作时间。';
        return;
      }
      preview.innerHTML = '将生成 <strong>' + days.length + ' 条</strong> 工作补录记录，共 <strong>' + (days.length * hours).toFixed(1) + ' 小时</strong>；日期段内的每一天都会计入日常工作统计。';
    }
    get('backfill-start-date').addEventListener('change', updateBackfillPreview);
    get('backfill-end-date').addEventListener('change', updateBackfillPreview);
    get('backfill-hours').addEventListener('input', updateBackfillPreview);
    get('backfill-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const project = get('backfill-project').value.trim();
      const days = datesForBackfill(get('backfill-start-date').value, get('backfill-end-date').value);
      const hours = Number(get('backfill-hours').value);
      const note = get('backfill-note').value.trim();
      if (!project) { toast('请填写所属项目。'); return; }
      if (!days.length || !(hours > 0 && hours <= 24)) { toast('请检查补录日期段和每日平均工作时间。'); return; }
      const idBase = Date.now();
      const endTime = timeAfter('09:00', hours);
      logs.push(...days.map((workDate, index) => ({
        id: idBase + index,
        workDate,
        title: '工作补录：' + project,
        project,
        category: '项目整理',
        hours,
        startTime: '09:00',
        endTime,
        progress: 100,
        outcome: note || '根据日期段补录的历史工作。',
        nextStep: '',
        meetingContent: '',
        painPoint: '',
        painSolution: '',
        painStatus: '已解决',
        painResponse: ''
      })));
      get('backfill-form').reset();
      get('backfill-start-date').value = today();
      get('backfill-end-date').value = today();
      get('backfill-hours').value = '8';
      updateBackfillPreview();
      save();
      toast('已补录 ' + days.length + ' 天工作，共 ' + (days.length * hours).toFixed(1) + ' 小时。');
    });
    updateBackfillPreview();
    get('open-pain-dialog').addEventListener('click', () => painDialog.showModal());
    get('close-pain-dialog').addEventListener('click', () => painDialog.close());
    get('pain-form').addEventListener('submit', (event) => {
      event.preventDefault();
      painDialog.close();
      toast(get('pain-point').value.trim() || get('pain-solution').value.trim() ? '痛点、解决方案与处理状态已设置。' : '已关闭痛点设置。');
    });
    get('open-data-dialog').addEventListener('click', () => {
      renderProfiles();
      dataDialog.showModal();
    });
    get('close-data-dialog').addEventListener('click', () => dataDialog.close());
    get('create-profile').addEventListener('click', () => {
      if (flowStartedAt || meetingStartedAt || taskTracking || meetingDraft) { toast('请先结束计时再新建用户。'); return; }
      const requestedName = get('new-profile-name').value.trim();
      if (!requestedName) {
        toast('请先填写使用者名称。');
        return;
      }
      const profile = { id: 'user-' + Date.now() + '-' + Math.random().toString(16).slice(2), name: uniqueProfileName(requestedName), reportOverrides: {} };
      profiles.push(profile);
      activeProfileId = profile.id;
      logs = [];
      tasks = [];
      reportOverrides = {};
      resetReportEditors();
      window.appStorage.setItem(profileDataKey(activeProfileId), JSON.stringify(logs));
      window.appStorage.setItem(profileTasksKey(activeProfileId), JSON.stringify(tasks));
      persistProfiles();
      get('new-profile-name').value = '';
      resetWorkForm();
      render();
      renderProfiles();
      toast('已新建“' + profile.name + '”的独立工作区。');
    });
    get('user-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-profile-id]');
      if (button) switchProfile(button.dataset.profileId);
    });
    get('export-data').addEventListener('click', exportBackup);
    get('import-data').addEventListener('change', (event) => importBackup(event.target.files && event.target.files[0]));
    get('cancel-edit').addEventListener('click', () => {
      resetWorkForm();
      toast('已取消修改。');
    });
    function setSummaryMode(nextMode) {
      if (!['week', 'month', 'year'].includes(nextMode)) return;
      cancelAiReport();
      mode = nextMode;
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.mode === nextMode));
      setReportEditing('period', false);
      render();
    }
    document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => setSummaryMode(button.dataset.mode)));
    get('anchor-date').addEventListener('change', () => {
      cancelAiReport();
      setReportEditing('period', false);
      render();
    });
    get('daily-date').addEventListener('change', () => {
      cancelAiReport();
      setReportEditing('daily', false);
      renderDailyReport();
    });
    function panelIdFromHash() {
      const id = decodeURIComponent(window.location.hash || '').replace(/^#/, '');
      return get(id) && get(id).classList ? id : 'work-entry';
    }
    function switchFeaturePanel(id, updateHash) {
      const target = get(id);
      if (!target || !target.classList || !target.classList.contains('feature-panel')) return;
      document.querySelectorAll('.feature-panel').forEach((panel) => panel.classList.toggle('active', panel === target));
      document.body.classList.toggle('flow-view', id === 'flow-mode');
      document.querySelectorAll('.nav-button, .nav-option').forEach((button) => {
        const menu = button.closest('.nav-menu');
        const menuSelected = button.classList.contains('nav-button') && menu && ((menu.dataset.menu === 'work' && ['work-entry', 'work-backfill'].includes(id)) || (menu.dataset.menu === 'summary' && ['daily-summary', 'period-summary'].includes(id)) || (menu.dataset.menu === 'records' && ['work-records', 'dashboard'].includes(id)));
        const exactPanelSelected = button.dataset.target === id && (!button.dataset.summaryMode || button.dataset.summaryMode === mode);
        const selected = exactPanelSelected || menuSelected;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-current', selected ? 'page' : 'false');
      });
      if (updateHash && window.location.hash !== '#' + id) window.location.hash = '#' + id;
      if (id === 'period-summary') syncPeriodReportHeight();
      if (updateHash) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function syncNavBackdrop() {
      document.body.classList.toggle('menu-open', !!document.querySelector('.nav-menu.open'));
    }
    function closeNavMenus(exceptMenu) {
      document.querySelectorAll('.nav-menu.open').forEach((menu) => {
        if (menu === exceptMenu) return;
        menu.classList.remove('open');
        const toggle = menu.querySelector('.nav-button');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
      syncNavBackdrop();
    }
    document.querySelectorAll('.nav-menu > .nav-button').forEach((button) => button.addEventListener('click', (event) => {
      if (window.matchMedia && window.matchMedia('(hover: hover)').matches) return;
      event.preventDefault();
      event.stopPropagation();
      const menu = button.closest('.nav-menu');
      const shouldOpen = !menu.classList.contains('open');
      closeNavMenus(menu);
      menu.classList.toggle('open', shouldOpen);
      button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      syncNavBackdrop();
    }));
    document.querySelectorAll('.nav-option').forEach((button) => button.addEventListener('click', () => {
      closeNavMenus();
      if (button.dataset.summaryMode) setSummaryMode(button.dataset.summaryMode);
      switchFeaturePanel(button.dataset.target, true);
    }));
    get('open-flow-mode').addEventListener('click', startFlowMode);
    get('leave-flow-mode').addEventListener('click', () => {
      switchFeaturePanel('work-entry', true);
      toast(flowStartedAt?'已暂离心流，计时仍在继续；可再次点击“心流模式”返回。':'已返回工作录入，心流尚未开始。');
    });
    document.querySelectorAll('.nav-button').forEach((button) => {
      if (button.closest('.nav-menu') || button.id === 'open-flow-mode') return;
      button.addEventListener('click', () => switchFeaturePanel(button.dataset.target, true));
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.nav-menu')) closeNavMenus();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeNavMenus();
    });
    window.addEventListener('hashchange', () => switchFeaturePanel(panelIdFromHash(), false));
    try {
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#work-entry');
    } catch (error) {
      window.location.hash = 'work-entry';
    }
    switchFeaturePanel('work-entry', false);
    get('log-list').addEventListener('click', (event) => {
      const editButton = event.target.closest('[data-edit]');
      if (editButton) {
        editLog(Number(editButton.dataset.edit));
        return;
      }
      const deleteButton = event.target.closest('[data-delete]');
      if (!deleteButton || !confirm('确定删除这条工作记录吗？')) return;
      const deletedId = Number(deleteButton.dataset.delete);
      logs = logs.filter((item) => item.id !== deletedId);
      if (editingId === deletedId) resetWorkForm();
      save();
      toast('记录已删除。');
    });
    const textEncoder = new TextEncoder();
    const zipCrcTable = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
      }
      return table;
    })();
    function xmlEscape(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[char]);
    }
    function writeU16(buffer, offset, value) {
      buffer[offset] = value & 255;
      buffer[offset + 1] = (value >>> 8) & 255;
    }
    function writeU32(buffer, offset, value) {
      const number = value >>> 0;
      buffer[offset] = number & 255;
      buffer[offset + 1] = (number >>> 8) & 255;
      buffer[offset + 2] = (number >>> 16) & 255;
      buffer[offset + 3] = (number >>> 24) & 255;
    }
    function crc32(data) {
      let value = 0xffffffff;
      for (let index = 0; index < data.length; index += 1) value = zipCrcTable[(value ^ data[index]) & 255] ^ (value >>> 8);
      return (value ^ 0xffffffff) >>> 0;
    }
    function zipStore(entries) {
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      entries.forEach((entry) => {
        const name = textEncoder.encode(entry.name);
        const data = entry.data instanceof Uint8Array ? entry.data : textEncoder.encode(entry.data);
        const crc = crc32(data);
        const local = new Uint8Array(30);
        writeU32(local, 0, 0x04034b50);
        writeU16(local, 4, 20);
        writeU16(local, 6, 0x0800);
        writeU16(local, 8, 0);
        writeU16(local, 10, 0);
        writeU16(local, 12, 0);
        writeU32(local, 14, crc);
        writeU32(local, 18, data.length);
        writeU32(local, 22, data.length);
        writeU16(local, 26, name.length);
        writeU16(local, 28, 0);
        localParts.push(local, name, data);
        const central = new Uint8Array(46);
        writeU32(central, 0, 0x02014b50);
        writeU16(central, 4, 0x0314);
        writeU16(central, 6, 20);
        writeU16(central, 8, 0x0800);
        writeU16(central, 10, 0);
        writeU16(central, 12, 0);
        writeU16(central, 14, 0);
        writeU32(central, 16, crc);
        writeU32(central, 20, data.length);
        writeU32(central, 24, data.length);
        writeU16(central, 28, name.length);
        writeU16(central, 30, 0);
        writeU16(central, 32, 0);
        writeU16(central, 34, 0);
        writeU16(central, 36, 0);
        writeU32(central, 38, 0);
        writeU32(central, 42, offset);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
      });
      const centralLength = centralParts.reduce((size, part) => size + part.length, 0);
      const end = new Uint8Array(22);
      writeU32(end, 0, 0x06054b50);
      writeU16(end, 4, 0);
      writeU16(end, 6, 0);
      writeU16(end, 8, entries.length);
      writeU16(end, 10, entries.length);
      writeU32(end, 12, centralLength);
      writeU32(end, 16, offset);
      writeU16(end, 20, 0);
      return new Blob(localParts.concat(centralParts, [end]), { type: 'application/zip' });
    }
    function downloadBlob(blob, filename) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    function reportFilename() {
      return modeName(mode) + '-' + rangeFor(mode, get('anchor-date').value).start;
    }
    function wordParagraph(line) {
      const heading = /^(?:[一二三四五六七八九十]+、|【|[STARL]｜)/.test(line) || line.indexOf('数据看板') === 0 || line.indexOf('待解决与待完成事项') === 0 || line.indexOf('已完成闭环') === 0 || line.indexOf('自身评价') === 0;
      const title = /^(?:周度|月度|年度).*(?:工作总结|总结)/.test(line);
      const size = title ? 36 : heading ? 28 : 22;
      const bold = title || heading ? '<w:b/>' : '';
      const color = title ? '123C45' : heading ? '18785F' : '172A33';
      const indent = /^\d+\./.test(line) ? '<w:ind w:left="360" w:hanging="360"/>' : '';
      return '<w:p><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/>' + indent + '</w:pPr><w:r><w:rPr><w:rFonts w:ascii="PingFang SC" w:hAnsi="PingFang SC" w:eastAsia="PingFang SC"/><w:sz w:val="' + size + '"/><w:color w:val="' + color + '"/>' + bold + '</w:rPr><w:t xml:space="preserve">' + xmlEscape(line || ' ') + '</w:t></w:r></w:p>';
    }
    function createDocx(reportText) {
      const paragraphs = reportText.split('\n').map(wordParagraph).join('');
      const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>';
      return zipStore([
        { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
        { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
        { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>工作总结</dc:title><dc:creator>节拍工作台</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString() + '</dcterms:created></cp:coreProperties>' },
        { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>节拍工作台</Application></Properties>' },
        { name: 'word/document.xml', data: documentXml }
      ]);
    }
    function pptParagraph(text, size, color, bold) {
      return '<a:p><a:pPr marL="0" indent="0"/><a:r><a:rPr lang="zh-CN" sz="' + size + '"' + (bold ? ' b="1"' : '') + '><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/></a:rPr><a:t>' + xmlEscape(text || ' ') + '</a:t></a:r><a:endParaRPr lang="zh-CN" sz="' + size + '"/></a:p>';
    }
    function pptTextBox(id, name, x, y, width, height, paragraphs) {
      return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + width + '" cy="' + height + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>' + paragraphs + '</p:txBody></p:sp>';
    }
    function pptSlideXml(title, period, lines) {
      const body = lines.map((line) => {
        const heading = /^(?:[一二三四五六七八九十]+、|【|[STARL]｜)/.test(line) || line.indexOf('数据看板') === 0 || line.indexOf('待解决与待完成事项') === 0 || line.indexOf('已完成闭环') === 0;
        return pptParagraph(line, heading ? 2200 : 1750, heading ? '0071E3' : '172A33', heading);
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7F8F5"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + pptTextBox('2', '标题', '609600', '406400', '10972800', '609600', pptParagraph(title, 3200, '123C45', true)) + pptTextBox('3', '周期', '609600', '1117600', '10972800', '406400', pptParagraph(period, 1500, '4F7D72', false)) + pptTextBox('4', '正文', '609600', '1676400', '10972800', '4876800', body) + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    }
    function createPptx(reportText) {
      const rawLines = reportText.split('\n').filter((line) => line.trim());
      const lines = rawLines.filter((line) => line !== summaryHeading(mode));
      const chunks = [];
      for (let index = 0; index < lines.length; index += 12) chunks.push(lines.slice(index, index + 12));
      if (!chunks.length) chunks.push(['暂无工作记录']);
      const period = rangeFor(mode, get('anchor-date').value).start + ' 至 ' + rangeFor(mode, get('anchor-date').value).end;
      const slideIds = chunks.map((chunk, index) => '<p:sldId id="' + (256 + index) + '" r:id="rId' + (index + 2) + '"/>').join('');
      const rels = chunks.map((chunk, index) => '<Relationship Id="rId' + (index + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (index + 1) + '.xml"/>').join('');
      const entries = [
        { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' + chunks.map((chunk, index) => '<Override PartName="/ppt/slides/slide' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') + '</Types>' },
        { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
        { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>工作总结</dc:title><dc:creator>节拍工作台</dc:creator></cp:coreProperties>' },
        { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>节拍工作台</Application><Slides>' + chunks.length + '</Slides></Properties>' },
        { name: 'ppt/presentation.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + slideIds + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' },
        { name: 'ppt/_rels/presentation.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + rels + '</Relationships>' },
        { name: 'ppt/slideMasters/slideMaster1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="节拍主题"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>' },
        { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>' },
        { name: 'ppt/slideLayouts/slideLayout1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>' },
        { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>' },
        { name: 'ppt/theme/theme1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="节拍"><a:themeElements><a:clrScheme name="节拍"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="173039"/></a:dk2><a:lt2><a:srgbClr val="F7F8F5"/></a:lt2><a:accent1><a:srgbClr val="18785F"/></a:accent1><a:accent2><a:srgbClr val="E49B4D"/></a:accent2><a:accent3><a:srgbClr val="6A8FC9"/></a:accent3><a:accent4><a:srgbClr val="A877B6"/></a:accent4><a:accent5><a:srgbClr val="D86E71"/></a:accent5><a:accent6><a:srgbClr val="718A70"/></a:accent6><a:hlink><a:srgbClr val="18785F"/></a:hlink><a:folHlink><a:srgbClr val="4F7D72"/></a:folHlink></a:clrScheme><a:fontScheme name="节拍"><a:majorFont><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/><a:cs typeface="PingFang SC"/></a:majorFont><a:minorFont><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/><a:cs typeface="PingFang SC"/></a:minorFont></a:fontScheme><a:fmtScheme name="节拍"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>' }
      ];
      chunks.forEach((chunk, index) => {
        entries.push({ name: 'ppt/slides/slide' + (index + 1) + '.xml', data: pptSlideXml(modeName(mode) + '工作总结', period, chunk) });
        entries.push({ name: 'ppt/slides/_rels/slide' + (index + 1) + '.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>' });
      });
      return zipStore(entries);
    }
    function printPdf() {
      const escaped = xmlEscape(get('report-text').value).replace(/\n/g, '<br>');
      const popup = window.open('', '_blank');
      if (!popup) {
        toast('请允许浏览器打开打印窗口后重试。');
        return;
      }
      popup.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + reportFilename() + '</title><style>body{font-family:"PingFang SC","苹方-简","Microsoft YaHei",Arial,sans-serif;color:#172a33;margin:34mm 24mm;line-height:1.85;font-size:11pt}h1{color:#123c45;font-size:20pt;margin:0 0 12mm}p{white-space:normal}@media print{body{margin:20mm}}</style></head><body><h1>' + xmlEscape(summaryHeading(mode)) + '</h1><p>' + escaped + '</p></body></html>');
      popup.document.close();
      popup.focus();
      window.setTimeout(() => popup.print(), 250);
    }
    get('copy-report').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(get('report-text').value); toast('报告已复制，可以直接粘贴到邮件、飞书或文档。'); }
      catch { get('report-text').select(); document.execCommand('copy'); toast('报告已复制。'); }
    });
    get('toggle-period-report').addEventListener('click', () => {
      if(periodReportEditing)finishReportEditing('period');else setReportEditing('period',true);
    });
    get('report-text').addEventListener('input', syncPeriodReportHeight);
    window.addEventListener('resize', syncPeriodReportHeight);
    get('copy-daily-report').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(get('daily-report-text').value); toast('本日报告已复制，可以直接粘贴使用。'); }
      catch { get('daily-report-text').select(); document.execCommand('copy'); toast('本日报告已复制。'); }
    });
    get('toggle-daily-report').addEventListener('click', () => {
      if(dailyReportEditing)finishReportEditing('daily');else setReportEditing('daily',true);
    });
    for(const type of ['period','daily']){
      get('restore-'+type+'-report').addEventListener('click',async()=>{
        if(await persistReport(type,null,'manual')){setReportEditing(type,false);render();toast('已恢复自动报告。');}
      });
      get('ai-'+type+'-report').addEventListener('click',()=>openAiReport(type));
    }
    get('ai-report-cancel').addEventListener('click',cancelAiReport);
    get('ai-report-dialog').addEventListener('cancel',cancelAiReport);
    get('ai-report-dialog').addEventListener('close',()=>{if(aiDraftScope&&!get('ai-report-dialog').open)cancelAiReport();});
    window.addEventListener('pagehide',cancelAiReport);
    get('ai-report-generate').addEventListener('click',async()=>{
      const scope=aiDraftScope;if(!scope||!sameAiScope(scope,scope.type))return;
      const id=++aiRequestId;
      aiAbortController?.abort();
      aiAbortController=new AbortController();
      get('ai-report-generate').disabled=true;get('ai-report-state').textContent=estimateAiBatches(scope.report.items)>1?'正在分批处理中，完成所有批次及合成后会显示草稿；请稍候…':'正在生成草稿，请稍候…';
      try{
        const result=await aiApi('generate',{report:scope.report},()=>id===aiRequestId&&get('ai-report-dialog').open&&sameAiScope(scope,scope.type),aiAbortController.signal);
        if(id!==aiRequestId||!get('ai-report-dialog').open)return;
        if(!sameAiScope(scope,scope.type)){get('ai-report-state').textContent='工作记录或报告范围已变化，请重新打开并预览。';return;}
        if(String(result.text||'').length>100000)throw Error('AI 草稿超过本地报告可保存长度，未截断或修改原报告。');
        get('ai-report-draft').value=String(result.text||'');
        get('ai-draft-label').hidden=false;get('ai-report-save').hidden=false;get('ai-report-generate').hidden=true;
        get('ai-report-state').textContent='草稿已生成'+(result.model?' · '+result.model:'')+'。可修改后保存。';
      }catch(error){if(id===aiRequestId)get('ai-report-state').textContent=aiGenerationErrorMessage(error);}
      finally{if(id===aiRequestId){aiAbortController=null;get('ai-report-generate').disabled=false;}}
    });
    get('ai-report-save').addEventListener('click',async()=>{
      const scope=aiDraftScope;if(!scope||!sameAiScope(scope,scope.type)){get('ai-report-state').textContent='报告范围或工作记录已变化，请重新生成。';return;}
      const text=get('ai-report-draft').value.trim();if(!text){get('ai-report-state').textContent='请填写草稿内容。';return;}
      get('ai-report-save').disabled=true;
      if(await persistReport(scope.type,text,'ai',scope.report)){get('ai-report-dialog').close();aiDraftScope=null;setReportEditing(scope.type,false);render();toast('AI 草稿已保存为本期报告。');}
      get('ai-report-save').disabled=false;
    });
    get('ai-connect').addEventListener('click',async()=>{
      const popup=window.open('about:blank','_blank');
      try{
        const result=await aiApi('connect',{});
        if(popup)popup.location.href=result.authorizeUrl;else toast('浏览器拦截了授权窗口，请允许弹出窗口后重试。');
        clearInterval(aiPoll);aiPoll=setInterval(async()=>{try{const status=await aiApi('status');showAiStatus(status);if(status.connected){clearInterval(aiPoll);aiPoll=null;if(popup&&!popup.closed)popup.close();toast('ChatGPT 已连接。');}}catch{}},2000);
        setTimeout(()=>{if(aiPoll){clearInterval(aiPoll);aiPoll=null;}},120000);
      }catch(error){if(popup)popup.close();get('ai-account-status').textContent='连接失败：'+error.message;}
    });
    get('ai-disconnect').addEventListener('click',async()=>{try{const result=await aiApi('disconnect',{});showAiStatus(result);if(result.revocationConfirmed===false){get('ai-account-status').textContent='本机连接已清除，远端撤销未确认。请在 ChatGPT 设置中撤销应用访问。';toast('本机已断开，远端撤销未确认。');}else toast('ChatGPT 已断开。');}catch(error){get('ai-account-status').textContent='断开失败：'+error.message;}});
    if(aiLocal)refreshAiStatus();
    else {get('ai-connect').disabled=true;get('ai-account-status').textContent='AI 辅助生成仅在本机 http://127.0.0.1:4173/ 服务可用。';}
    get('export-word').addEventListener('click', () => {
      downloadBlob(createDocx(get('report-text').value), reportFilename() + '.docx');
      toast('已导出可编辑 Word 文档。');
    });
    get('export-ppt').addEventListener('click', () => {
      downloadBlob(createPptx(get('report-text').value), reportFilename() + '.pptx');
      toast('已导出可编辑 PowerPoint。');
    });
    get('export-pdf').addEventListener('click', () => {
      printPdf();
      toast('请在打印窗口选择“另存为 PDF”。');
    });
    if (typeof reportDesktopDiagnostic === 'function') reportDesktopDiagnostic('handlers-bound');
    updateDurationPreview();
    renderProfiles();
    render();

    function hasWorkFormChanges(){
      const record=editingId?logs.find(item=>item.id===editingId):null;
      const fields=[['title','title'],['project','project'],['category','category'],['work-date','workDate'],['start-time','startTime'],['end-time','endTime'],['progress','progress'],['outcome','outcome'],['next-step','nextStep'],['pain-point','painPoint'],['pain-solution','painSolution'],['pain-response','painResponse']];
      if(record)return fields.some(([id,key])=>get(id).value.trim()!==String(key==='category'?normalizeCategory(record[key]):record[key]??''))||document.querySelector('input[name="pain-status"]:checked').value!==(record.painStatus||'已解决');
      return fields.filter(([id])=>['title','outcome','next-step','pain-point','pain-solution','pain-response'].includes(id)).some(([id])=>get(id).value.trim());
    }
    workbench.bind({
      refresh(workspace) {
        if(aiDraftScope&&!sameAiScope(aiDraftScope,aiDraftScope.type))cancelAiReport();
        if(flowStartIntent&&flowStartIntent.workspaceId!==workspace.workspaceId){flowStartIntent=null;}
        profiles = workspace.profiles.map(({id,name,avatar,reportOverrides}) => ({id,name,avatar,reportOverrides:reportOverrides||{}}));
        activeProfileId = workspace.activeProfileId;
        const profile = workspace.profiles.find(p => p.id === activeProfileId);
        logs = profile.records.map(normalizeLog); tasks = normalizeTasks(profile.tasks);
        reportOverrides = profile.reportOverrides || {};
        render(); renderProfiles();
        if(document.querySelector('.session-recovery')){renderSessionRecovery();renderFlowRecovery();}
      },
      hasFormDraft:hasWorkFormChanges,discardFormDraft:resetWorkForm,
      timerGuard: () => Boolean(flowStartedAt || meetingStartedAt || taskTracking || meetingDraft),
      formGuard: () => {
        const dirty=hasWorkFormChanges();
        if (dirty && !confirm('工作表单尚未保存。放弃修改并切换数据来源？')) return false;
        if (dirty) resetWorkForm(); return true;
      }
    });

    function sessionSnapshot(kind) {
      const started = kind === 'flow' ? flowStartedAt : kind === 'meeting' ? meetingStartedAt : taskTracking?.startedAt;
      const session = workbench.controller.getWorkspace().sessions.find(s => s.id === sessionIds[kind]);
      const draft = kind === 'flow' ? {project:get('flow-project').value,category:get('flow-category').value,tasks:flowDraftTasks} : kind === 'meeting' ? {project:get('meeting-project').value || get('project').value,content:get('meeting-dialog-content').value,outcome:get('meeting-outcome').value,tasks:meetingDraftTasks,meetingDraft} : {project:taskTracking?.project || session?.draft.project};
      const run=sessionRuns[kind];
      const segments=splitTimeSegments(run ? [...run.prior,{start:run.start,end:run.end || Date.now()}] : session?.draft.segments || []);
      return {elapsedMs:started ? Math.max(0,Date.now()-started.getTime()) : kind === 'meeting' && meetingDraft ? meetingDraft.hours*3600000 : session?.elapsedMs || 0,draft:{...session?.draft,...draft,segments,originDate:session?.draft.originDate || dateKey(started || new Date()),originTime:session?.draft.originTime || timeString(started || new Date())}};
    }
    async function beginSession(kind) {
      if (!workbench.isDirectory()) return;
      const id = globalThis.crypto?.randomUUID?.() || ('session-'+Date.now()+'-'+Math.random());
      sessionIds[kind] = id;
      sessionRuns[kind] = {start:Date.now(),prior:[]};
      const snapshot = sessionSnapshot(kind);
      try { await workbench.controller.commit(w => {w.sessions.push({id,workspaceId:w.workspaceId,profileId:activeProfileId,kind,status:'running',checkpointAt:new Date().toISOString(),...snapshot});return w;}); }
      catch(e) { toast('计时检查点未保存：'+e.message); }
    }
    async function discardSession(kind) {
      const id=sessionIds[kind]; if (!id) return;
      await workbench.controller.commit(w => {w.sessions=w.sessions.filter(s=>s.id!==id);return w;});delete sessionIds[kind];
    }
    function applySessionRecord(record,kind) {
      const id=sessionIds[kind];if (!id) return;
      const session=workbench.controller.getWorkspace().sessions.find(s=>s.id===id);
      record.sessionId=id;
      record.timeSegments=sessionSnapshot(kind).draft.segments;
      record.hours=segmentHours(record.timeSegments);
      if(session){record.workDate=session.draft.originDate;record.startTime=session.draft.originTime;record.endTime=timeString(new Date(record.timeSegments.at(-1).end));}
      delete sessionIds[kind];delete sessionRuns[kind];
    }
    async function checkpointSessions() {
      if ((!workbench.isDirectory()&&!sessionIds.flow) || checkpointBusy || workbench.isPending() || !Object.keys(sessionIds).length) return;
      checkpointBusy=true;
      const snapshots=Object.fromEntries(Object.entries(sessionIds).map(([kind,id])=>[id,sessionSnapshot(kind)]));
      try {await workbench.controller.commit(w=>{for(const s of w.sessions)if(snapshots[s.id]){Object.assign(s,snapshots[s.id]);s.checkpointAt=new Date().toISOString();}return w;});if(sessionIds.flow&&!flowFinishBusy){const saved=workbench.controller.getWorkspace().sessions.find(s=>s.id===sessionIds.flow);get('flow-save-state').textContent='开始时间已保存：'+formatFlowTimestamp(flowStartTime(saved))+'\n最近成功检查点：'+formatFlowTimestamp(Date.parse(saved.checkpointAt));}}
      catch(e){get('storage-detail').textContent='计时检查点未保存：'+e.message;if(sessionIds.flow){const saved=workbench.controller.getWorkspace().sessions.find(s=>s.id===sessionIds.flow);get('flow-save-state').textContent='心流检查点未保存，请重试或导出。'+e.message+'\n'+(saved?.elapsedMs>0?'最近成功检查点：'+formatFlowTimestamp(Date.parse(saved.checkpointAt)):'暂无后续成功检查点；开始时间仍已保留。');}}
      finally{checkpointBusy=false;}
    }
    function formatFlowTimestamp(ms){
      const d=new Date(ms);return dateKey(d)+' '+timeString(d)+':'+String(d.getSeconds()).padStart(2,'0')+'.'+String(d.getMilliseconds()).padStart(3,'0');
    }
    function createFlowRecoveryBox(){
      const box=document.createElement('section');box.className='storage-startup session-recovery flow-checkpoint-recovery';box.hidden=true;box.setAttribute('aria-live','polite');document.body.prepend(box);return box;
    }
    function pendingRecoveryFlows(){
      return workbench.controller.getWorkspace().sessions.filter(s=>s.kind==='flow'&&!Object.values(sessionIds).includes(s.id)&&!(flowStartBusy&&flowStartIntent?.id===s.id));
    }
    function renderFlowRecovery(){
      if(flowRecoveryBusy)return flowRecoveryPromise;
      const w=workbench.controller.getWorkspace(),flows=pendingRecoveryFlows();
      if(!flows.length){flowRecoveryBox.hidden=true;return;}
      const key=w.workspaceId+':'+w.revision+':'+flows.map(s=>s.id).join(',');
      if(key===flowRecoveryAttempt)return flowRecoveryPromise;
      flowRecoveryAttempt=key;flowRecoveryPromise=recoverCheckpointFlows();return flowRecoveryPromise;
    }
    async function recoverCheckpointFlows(){
      if(flowRecoveryBusy)return;
      flowRecoveryBusy=true;flowRecoveryBox.hidden=false;flowRecoveryBox.replaceChildren();
      const workspaceId=workbench.controller.getWorkspace().workspaceId,flows=pendingRecoveryFlows();let saved=0,empty=0;const errors=[];
      try{
        get('flow-save-state').textContent='正在按最后成功检查点自动保存上次心流…';
        for(const session of flows){
          if(Object.values(sessionIds).includes(session.id))continue;
          try{
            if(workbench.controller.getWorkspace().workspaceId!==workspaceId)throw Error('数据来源已变化，请重新读取');
            const result=await settleCheckpointFlow(workbench.controller,session.id,Date.now());
            if(result.status==='saved')saved++;if(result.status==='empty')empty++;
          }catch(e){errors.push('会话 '+session.id+'：'+e.message);}
        }
        const message=(saved?'已按成功检查点保存 '+saved+' 条心流，不计关闭后间隔。':'')+(empty?' '+empty+' 条心流尚无正时长检查点，起点与零时长结束凭据已保留，未生成工时。':'');
        const status=document.createElement('p');status.textContent=message+(errors.length?' 自动结算尚未完成，原会话仍保留。'+errors.join('；'):'');flowRecoveryBox.append(status);get('flow-save-state').textContent=status.textContent;
        if(errors.length){
          const retry=document.createElement('button');retry.type='button';retry.textContent='重试自动保存';retry.onclick=()=>{flowRecoveryAttempt='';return renderFlowRecovery();};
          const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent='导出全工作台待保存数据';exportButton.onclick=()=>workbench.exportCurrentSnapshot();
          const access=document.createElement('button');access.type='button';access.textContent='保存状态 / 重新授权';access.onclick=()=>get('open-data-dialog').click();flowRecoveryBox.append(retry,exportButton,access);
          get('storage-other-actions').open=true;
        }else{flowRecoveryBox.hidden=true;if(message)toast(message);}
        workbench.sync();
      }finally{flowRecoveryBusy=false;}
    }
    let flowRecoveryBusy=false,flowRecoveryAttempt='',flowRecoveryPromise=null;
    const flowRecoveryBox=createFlowRecoveryBox();
    window.setInterval(checkpointSessions,15000);
    const recoveryBox=document.createElement('section');recoveryBox.className='session-recovery';get('data-dialog').querySelector('.data-enhancements').append(recoveryBox);
    function renderSessionRecovery(){
      recoveryBox.replaceChildren();
      for(const session of workbench.controller.getWorkspace().sessions.filter(s=>s.kind!=='flow'&&!Object.values(sessionIds).includes(s.id))){
        const text=document.createElement('p');text.textContent='有待恢复的'+({flow:'心流',meeting:'会议',task:'任务追踪'}[session.kind])+'：'+Math.round(session.elapsedMs/1000)+'秒，关闭期间不计时。';recoveryBox.append(text);
        const resume=document.createElement('button');resume.textContent='恢复计时';resume.onclick=async()=>{
          if(flowStartedAt||meetingStartedAt||taskTracking||meetingDraft){toast('请先结束当前计时');return;}
          if(activeProfileId!==session.profileId)switchProfile(session.profileId);
          sessionIds[session.kind]=session.id;
          sessionRuns[session.kind]={start:Date.now(),prior:session.draft.segments || [],restored:true};
          const started=new Date(Date.now()-session.elapsedMs);
          if(session.kind==='flow'){flowStartedAt=started;get('flow-project').value=session.draft.project||'';get('flow-category').value=session.draft.category||'项目推进';flowDraftTasks=session.draft.tasks||[];renderDraftTasks('flow');flowTimer=window.setInterval(updateFlowControls,1000);switchFeaturePanel('flow-mode',true);}
          if(session.kind==='meeting'){meetingStartedAt=started;meetingDraftTasks=session.draft.tasks||[];get('meeting-project').value=session.draft.project||'';get('meeting-dialog-content').value=session.draft.content||'';get('meeting-outcome').value=session.draft.outcome||'';meetingTimer=window.setInterval(updateMeetingControls,1000);updateMeetingControls();}
          if(session.kind==='task'){taskTracking={project:session.draft.project,startedAt:started};taskTrackingTimer=window.setInterval(updateTaskTrackingControls,1000);renderPendingTasks();}
          renderSessionRecovery();toast('计时已恢复，仅从上次成功检查点继续。');
        };
        const discard=document.createElement('button');discard.textContent='放弃';discard.onclick=async()=>{if(!confirm('放弃此会话？不会生成工作记录。'))return;try{await workbench.controller.commit(w=>{w.sessions=w.sessions.filter(s=>s.id!==session.id);return w;});renderSessionRecovery();}catch(e){toast('放弃未保存：'+e.message);}};recoveryBox.append(resume,discard);
      }
    }
    renderSessionRecovery();
    renderFlowRecovery();
    updateFlowStartControls();
    if(workbench.controller.getWorkspace().sessions.some(s=>s.kind!=='flow')&&!workbench.controller.getWorkspace().sessions.some(s=>s.kind==='flow')){dataDialog.showModal();toast('发现上次计时检查点，请恢复或放弃。');}
