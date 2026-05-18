// ==UserScript==
// @name         Yandex Practicum Auto Solution
// @namespace    local.practicum.auto-solution
// @version      1.0.0
// @description  Clicks check until the solution is available, confirms the modal, copies the sample answer, and tries to paste it into Monaco.
// @match        https://practicum.yandex.ru/trainer/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__practicumAutoSolutionLoaded) {
    console.info('[PracticumAutoSolution] Already loaded');
    return;
  }
  window.__practicumAutoSolutionLoaded = true;

  const config = {
    maxCheckClicks: 8,
    clickPauseMs: 2200,
    waitTimeoutMs: 120000,
    pasteIntoEditor: true,
    copyToClipboard: true,
    closeSolutionModal: true,
    checkSolutionBeforeNext: true,
    clickNextButton: true,
    continuousRun: true,
    autoSkipNoTaskPages: true,
    loopPauseMs: 2500,
    nextPageWaitMs: 60000,
  };

  window.__practicumAutoSolutionStopRequested = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const isStopRequested = () => Boolean(window.__practicumAutoSolutionStopRequested);
  let activeWorkArea = null;
  let lastProcessedQuizArea = null;
  const processedQuizAreas = new WeakSet();
  const clickedPassThroughButtons = new WeakSet();

  function createStatus() {
    const box = document.createElement('div');
    box.id = 'practicum-auto-solution-status';
    box.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:12px 38px 12px 14px',
      'border-radius:8px',
      'background:#111827',
      'color:#f9fafb',
      'font:13px/1.4 Arial,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.35)',
      'white-space:pre-wrap',
    ].join(';');
    const message = document.createElement('div');
    message.style.cssText = 'padding-bottom:8px';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.style.cssText = [
      'border:1px solid rgba(249,250,251,.35)',
      'border-radius:4px',
      'background:rgba(249,250,251,.08)',
      'color:#f9fafb',
      'font:12px/1.2 Arial,sans-serif',
      'padding:4px 8px',
      'cursor:pointer',
    ].join(';');
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close status');
    close.textContent = 'x';
    close.style.cssText = [
      'position:absolute',
      'top:6px',
      'right:8px',
      'width:22px',
      'height:22px',
      'border:0',
      'border-radius:4px',
      'background:transparent',
      'color:#f9fafb',
      'font:16px/22px Arial,sans-serif',
      'cursor:pointer',
      'opacity:.75',
    ].join(';');
    const state = { box, message, dismissed: false };
    stop.addEventListener('click', () => {
      window.__practicumAutoSolutionStopRequested = true;
      message.textContent = 'Stopped.';
    });
    close.addEventListener('click', () => {
      state.dismissed = true;
      box.remove();
    });
    box.append(message, stop, close);
    document.documentElement.appendChild(box);
    return state;
  }

  const status = createStatus();

  function log(message) {
    const line = `[PracticumAutoSolution] ${message}`;
    console.log(line);
    if (status.dismissed) return;
    if (!status.box.isConnected) {
      document.documentElement.appendChild(status.box);
    }
    status.message.textContent = message;
  }

  function isUsable(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      element.getClientRects().length > 0 &&
      !element.disabled &&
      element.getAttribute('aria-disabled') !== 'true'
    );
  }

  function closestButton(element) {
    return element?.matches?.('button,[role="button"],a')
      ? element
      : element?.closest?.('button,[role="button"],a');
  }

  function byTestId(testId) {
    return closestButton(document.querySelector(`[data-test-id="${testId}"]`));
  }

  function buttonByText(text) {
    const candidates = [...document.querySelectorAll('button,[role="button"],a')];
    return candidates.find((element) => normalize(element.textContent) === text);
  }

  function buttonByAnyText(texts) {
    const normalizedTexts = texts.map(normalize);
    const candidates = [...document.querySelectorAll('button,[role="button"],a')];
    return candidates.find((element) => normalizedTexts.includes(normalize(element.textContent)));
  }

  function firstUsableOrFirst(candidates) {
    const buttons = candidates.map(closestButton).filter(Boolean);
    return buttons.find(isUsable) || buttons[0] || null;
  }

  function getCheckableQuizAreas() {
    return [...document.querySelectorAll('.quiz__coding')].filter((area) =>
      area.querySelector('[data-test-id="quiz-coding-check-code-button"]'),
    );
  }

  function isVisibleQuizArea(area) {
    if (!area) return false;
    const style = getComputedStyle(area);
    return style.visibility !== 'hidden' && style.display !== 'none' && area.getClientRects().length > 0;
  }

  function isAfterQuizArea(area, previousArea) {
    if (!area || !previousArea || !previousArea.isConnected) return true;
    return Boolean(previousArea.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function getCheckableQuizAreasAfter(area) {
    return getCheckableQuizAreas().filter((candidate) => candidate !== area && isAfterQuizArea(candidate, area));
  }

  function getQuizSolutionButton(area) {
    if (!area?.querySelector) return null;

    return firstUsableOrFirst([
      ...area.querySelectorAll('.quiz__coding-author-solution-student-button'),
      ...area.querySelectorAll('.author-solution-student-button'),
      ...[...area.querySelectorAll('button,[role="button"],a')].filter(
        (element) => normalize(element.textContent) === 'Решение',
      ),
    ]);
  }

  function findQuizAreaWithSolution() {
    const area = getNextQuizWorkArea();
    return area && getQuizSolutionButton(area) ? area : null;
  }

  function getNextQuizWorkArea() {
    const allAreas = getCheckableQuizAreas();
    const visibleAreas = allAreas.filter(isVisibleQuizArea);
    const areas = (visibleAreas.length ? visibleAreas : allAreas)
      .filter((area) => !processedQuizAreas.has(area))
      .filter((area) => isAfterQuizArea(area, lastProcessedQuizArea));

    return areas[areas.length - 1] || null;
  }

  function getCurrentQuizWorkArea() {
    if (activeWorkArea?.matches?.('.quiz__coding')) return activeWorkArea;

    const allAreas = getCheckableQuizAreas();
    const visibleAreas = allAreas.filter(isVisibleQuizArea);
    const areas = visibleAreas.length ? visibleAreas : allAreas;
    return areas[areas.length - 1] || null;
  }

  function selectWorkArea() {
    const nextQuizArea = getNextQuizWorkArea();
    if (nextQuizArea) {
      activeWorkArea = nextQuizArea;
      return activeWorkArea;
    }

    const trainerCheckButton = document.querySelector('[data-test-id="check-task-button"]');
    if (trainerCheckButton) {
      activeWorkArea = document.querySelector('.trainer__body') || document;
      return activeWorkArea;
    }

    return activeWorkArea;
  }

  function getCheckButton(area = activeWorkArea) {
    const root = area || document;

    if (root !== document && root.querySelector) {
      return firstUsableOrFirst([
        ...root.querySelectorAll('[data-test-id="quiz-coding-check-code-button"]'),
        ...root.querySelectorAll('[data-test-id="quiz-coding-check-code-button-content"]'),
        ...[...root.querySelectorAll('button,[role="button"],a')].filter(
          (element) => normalize(element.textContent) === 'Проверить',
        ),
      ]);
    }

    return firstUsableOrFirst([
      document.querySelector('[data-test-id="check-task-button"]'),
      document.querySelector('[data-test-id="check-task-button-content"]'),
      ...[...document.querySelectorAll('button,[role="button"],a')].filter(
        (element) => normalize(element.textContent) === 'Проверить',
      ),
    ]);
  }

  function getSolutionButton(area = activeWorkArea) {
    const root = area || document;

    if (root !== document && root.querySelector) {
      return getQuizSolutionButton(root);
    }

    return firstUsableOrFirst([
      document.querySelector('[data-test-id="trainer-author-solution-student-button"]'),
      document.querySelector('[data-test-id="trainer-author-solution-student-button-content"]'),
      ...[...document.querySelectorAll('button,[role="button"],a')].filter(
        (element) => normalize(element.textContent) === 'Решение',
      ),
    ]);
  }

  function getConfirmSolutionButton() {
    return (
      byTestId('author-solution-confirmation-modal-button-confirm') ||
      byTestId('author-solution-confirmation-modal-button-confirm-content') ||
      buttonByText('Посмотреть решение')
    );
  }

  function getCloseSolutionModalButton() {
    const modal = document.querySelector('[data-test-id="author-solution-modal"], .author-solution-modal');
    return (
      byTestId('author-solution-modal-button-close') ||
      byTestId('author-solution-modal-button-close-content') ||
      closestButton(modal?.querySelector('.author-solution-modal__close')) ||
      closestButton(modal?.querySelector('[aria-label="Закрыть"]'))
    );
  }

  function getNextButton() {
    const selectors = [
      '[data-test-id="next-task-button"]',
      '[data-test-id="trainer-footer-next-task-button"]',
      '[data-test-id="trainer-footer-next-lesson-button"]',
      '.trainer-footer__next-task-button',
      '.trainer-footer__next-lesson-button',
      '.next-lesson-control__button',
    ];

    const selectorButtons = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .map(closestButton)
      .filter(Boolean);
    const selectorButton = selectorButtons.find(isUsable);
    if (selectorButton) return selectorButton;

    const nextTexts = ['Далее', 'Следующее задание', 'Следующий урок', 'К следующему уроку', 'Продолжить'];
    return [...document.querySelectorAll('button,[role="button"],a')]
      .filter((element) => nextTexts.includes(normalize(element.textContent)))
      .find(isUsable);
  }

  function hasTaskControls() {
    return Boolean(getCheckableQuizAreas().length || document.querySelector('[data-test-id="check-task-button"]'));
  }

  function getTheoryOnlyActionButton() {
    if (!config.autoSkipNoTaskPages || hasTaskControls()) return null;

    const candidates = [
      ...document.querySelectorAll('[data-test-id^="theory-action-button-"]'),
      ...document.querySelectorAll('.content-expander__button'),
    ]
      .map(closestButton)
      .filter((button, index, buttons) => button && buttons.indexOf(button) === index)
      .filter((button) => !clickedPassThroughButtons.has(button));

    return candidates.find(isUsable) || null;
  }

  function getPassThroughPageButton() {
    if (!config.autoSkipNoTaskPages || hasTaskControls()) return null;
    const nextButton = getNextButton();
    if (nextButton && !clickedPassThroughButtons.has(nextButton)) return nextButton;
    return getTheoryOnlyActionButton();
  }

  function getNextLessonUrlFromPreloadedData() {
    if (!config.autoSkipNoTaskPages || hasTaskControls()) return '';

    const data = window.__preloadedData__;
    const lesson = data?.apiData?.getLessonById;
    const nextLessonId = lesson?.next_lesson_id_overwrite || lesson?.next_lesson_id;
    if (!nextLessonId) return '';

    const originalUrl = data?.originalUrl || window.location.pathname;
    const nextPath = originalUrl.replace(/\/lesson\/[^/]+\/?/, `/lesson/${nextLessonId}/`);
    if (!nextPath || nextPath === originalUrl) return '';

    return new URL(nextPath, window.location.origin).href;
  }

  function clickElement(element, label) {
    const target = closestButton(element);
    if (!isUsable(target)) return false;
    rememberWorkArea(target);
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    log(`Clicked: ${label}`);
    return true;
  }

  function clickElementRelaxed(element, label) {
    const target = closestButton(element);
    if (!target) return false;
    rememberWorkArea(target);
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();
    log(`Clicked: ${label}`);
    return true;
  }

  function rememberWorkArea(element) {
    const quizArea = element?.closest?.('.quiz__coding');
    if (quizArea) {
      activeWorkArea = quizArea;
      return;
    }

    const area = element?.closest?.('.trainer__body, .trainer-editor, main');
    if (area && !activeWorkArea?.matches?.('.quiz__coding')) {
      activeWorkArea = area;
    }
  }

  function getWorkAreas() {
    const quizArea = getCurrentQuizWorkArea();
    return [
      quizArea,
      activeWorkArea,
      document.querySelector('.trainer__body'),
      document,
    ].filter((area, index, areas) => area && areas.indexOf(area) === index);
  }

  async function waitFor(getter, timeoutMs = config.waitTimeoutMs, intervalMs = 250) {
    const started = Date.now();
    while (!isStopRequested() && Date.now() - started < timeoutMs) {
      const value = getter();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  function cleanLine(text) {
    return (text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '');
  }

  function extractCodeFromPanel(panel) {
    const rows = [...panel.querySelectorAll('table tbody tr')];
    if (rows.length) {
      return rows
        .map((row) => {
          const cells = [...row.children].filter((cell) => cell.tagName === 'TD');
          const contentCell = cells[cells.length - 1];
          const content = contentCell?.querySelector('pre pre') || contentCell?.querySelector('pre') || contentCell;
          return cleanLine(content?.textContent || '');
        })
        .join('\n')
        .replace(/\n+$/g, '');
    }

    const pre = panel.querySelector('pre');
    return cleanLine(pre?.textContent || '').replace(/\n+$/g, '');
  }

  function extractSampleSolution(modal) {
    const panels = [...modal.querySelectorAll('.author-solution-modal__code-tabs-panel')];
    const solutionPanel = panels[1] || panels.find((panel) => panel.querySelector('.author-solution-modal__clipboard-button')) || panels[0];
    if (!solutionPanel) return '';
    return extractCodeFromPanel(solutionPanel);
  }

  async function copyText(text) {
    if (!config.copyToClipboard || !text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    }
  }

  function pasteIntoCodeMirror(text) {
    if (!config.pasteIntoEditor || !text) return false;

    for (const area of getWorkAreas()) {
      const editors = [...area.querySelectorAll?.('.CodeMirror') || []];

      for (const editorElement of editors) {
        const editor = editorElement.CodeMirror;
        if (!editor) continue;

        const doc = editor.getDoc?.();
        if (doc?.setValue) {
          doc.setValue(text);
        } else if (editor.setValue) {
          editor.setValue(text);
        } else {
          continue;
        }

        editor.focus?.();
        editor.refresh?.();
        editor.save?.();
        editorElement.dispatchEvent(new Event('input', { bubbles: true }));
        editorElement.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    return false;
  }

  function pasteIntoMonaco(text) {
    if (!config.pasteIntoEditor || !text) return false;

    const monacoApi = window.monaco;
    const areas = getWorkAreas();
    const editorNodes = [
      ...new Set(areas.flatMap((area) => [...area.querySelectorAll?.('.monaco-editor') || []])),
    ];
    const editors = monacoApi?.editor?.getEditors?.() || [];
    const scopedEditor = editors.find((editor) => {
      const node = editor.getDomNode?.();
      return node && editorNodes.some((editorNode) => editorNode === node || editorNode.contains(node) || node.contains(editorNode));
    });

    if (scopedEditor) {
      const model = scopedEditor.getModel?.();
      if (model?.setValue) {
        model.setValue(text);
      } else if (scopedEditor.setValue) {
        scopedEditor.setValue(text);
      } else {
        return false;
      }
      scopedEditor.focus?.();
      scopedEditor.getDomNode?.()?.dispatchEvent(new Event('input', { bubbles: true }));
      scopedEditor.getDomNode?.()?.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const models = monacoApi?.editor?.getModels?.() || [];
    const monacoEditorCount = document.querySelectorAll('.monaco-editor').length;
    if (models.length && (models.length === 1 || monacoEditorCount <= 1)) {
      const model =
        models.find((item) => item.getLanguageId?.() && item.getValue?.().trim()) ||
        models.find((item) => item.getLanguageId?.()) ||
        models[0];
      model.setValue(text);
      return true;
    }

    const textarea = areas
      .flatMap((area) => [...area.querySelectorAll?.('.monaco-editor textarea') || []])
      .find(Boolean);
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function pasteIntoPlainEditor(text) {
    if (!config.pasteIntoEditor || !text) return false;

    for (const area of getWorkAreas()) {
      const input = area.querySelector?.('textarea, [contenteditable="true"]');
      if (!input) continue;

      input.focus();

      if (input.matches('textarea,input')) {
        const setter =
          Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
      } else {
        input.textContent = text;
      }

      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return false;
  }

  function pasteIntoEditor(text) {
    return pasteIntoCodeMirror(text) || pasteIntoMonaco(text) || pasteIntoPlainEditor(text);
  }

  async function closeEditorNotifications() {
    const areas = getWorkAreas();
    const closeSelectors = [
      '.notification__close',
      '.quiz__coding-notification-content[aria-label="Закрыть"]',
      'button[aria-label="Закрыть"].quiz__coding-notification-content',
    ];

    let closedCount = 0;

    for (const area of areas) {
      const buttons = closeSelectors
        .flatMap((selector) => [...area.querySelectorAll?.(selector) || []])
        .map(closestButton)
        .filter(Boolean);

      for (const button of [...new Set(buttons)]) {
        button.click();
        closedCount += 1;
        await sleep(150);
      }
    }

    if (closedCount > 0) {
      await sleep(400);
    }

    return closedCount;
  }

  async function closeSolutionModal() {
    if (!config.closeSolutionModal) return false;

    const closeButton = await waitFor(() => {
      const button = getCloseSolutionModalButton();
      return isUsable(button) ? button : null;
    }, 10000);

    if (!closeButton) return false;

    clickElement(closeButton, 'Закрыть окно решения');
    await waitFor(
      () => !document.querySelector('[data-test-id="author-solution-modal"], .author-solution-modal'),
      10000,
    );
    await sleep(500);
    return true;
  }

  async function checkSolutionBeforeNext() {
    if (!config.checkSolutionBeforeNext) return false;

    const quizArea = getCurrentQuizWorkArea();
    if (quizArea) activeWorkArea = quizArea;
    const laterQuizCountBeforeCheck = quizArea ? getCheckableQuizAreasAfter(quizArea).length : 0;

    await sleep(700);
    const checkButton = await waitFor(() => {
      const button = getCheckButton(quizArea || activeWorkArea);
      return isUsable(button) ? button : null;
    }, 30000);

    if (!checkButton) return !quizArea && Boolean(getNextButton());

    clickElement(checkButton, 'Проверить правильное решение');

    const nextStep = await waitFor(() => {
      if (quizArea && getCheckableQuizAreasAfter(quizArea).length > laterQuizCountBeforeCheck) {
        return 'next-quiz';
      }

      const button = getNextButton();
      return isUsable(button) ? 'next-button' : null;
    }, 60000, 500);

    return Boolean(nextStep);
  }

  async function clickNextButton() {
    if (!config.clickNextButton) return false;

    if (getNextQuizWorkArea()) return false;

    const nextButton = await waitFor(() => {
      const button = getNextButton();
      return isUsable(button) ? button : null;
    }, 15000);

    if (!nextButton) return false;

    clickElement(nextButton, 'Далее');
    return true;
  }

  function markActiveWorkAreaProcessed() {
    if (activeWorkArea?.matches?.('.quiz__coding')) {
      processedQuizAreas.add(activeWorkArea);
      lastProcessedQuizArea = activeWorkArea;
      activeWorkArea = null;
    }
  }

  async function handlePassThroughPage(cycleNumber = 1) {
    const previousUrl = window.location.href;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (isStopRequested()) return { stopped: true };

      const button = await waitFor(() => {
        const candidate = getPassThroughPageButton();
        return isUsable(candidate) ? candidate : null;
      }, 5000);

      if (!button) break;

      clickedPassThroughButtons.add(closestButton(button));
      clickElementRelaxed(button, `No-task page action (${attempt}/5)`);
      await sleep(config.loopPauseMs);

      if (window.location.href !== previousUrl) {
        return { nextClicked: true, passThrough: true };
      }

      const taskAppeared = selectWorkArea();
      if (taskAppeared && (getCheckButton(taskAppeared) || getSolutionButton(taskAppeared))) {
        return { nextClicked: false, passThrough: true, continueSamePage: true };
      }
    }

    const nextLessonUrl = getNextLessonUrlFromPreloadedData();
    if (nextLessonUrl) {
      log(`Cycle ${cycleNumber}: no-task page, opening next lesson directly.`);
      window.location.assign(nextLessonUrl);
      return { nextClicked: true, passThrough: true };
    }

    return { nextClicked: false, passThrough: true };
  }

  async function runSingleCycle(cycleNumber = 1) {
    try {
      if (isStopRequested()) return { stopped: true };

      log(`Cycle ${cycleNumber}: waiting for the task UI...`);
      const initialUi = await waitFor(() => {
        const area = selectWorkArea();
        if (area && (getCheckButton(area) || getSolutionButton(area))) return 'task';
        if (getPassThroughPageButton() || getNextLessonUrlFromPreloadedData()) return 'pass-through';
        return null;
      }, 30000);
      if (isStopRequested()) return { stopped: true };

      if (initialUi === 'pass-through') {
        return handlePassThroughPage(cycleNumber);
      }

      if (!activeWorkArea) {
        throw new Error('No checkable task editor was found.');
      }

      for (let attempt = 1; attempt <= config.maxCheckClicks; attempt += 1) {
        if (isStopRequested()) return { stopped: true };

        const solutionButton = getSolutionButton(activeWorkArea);
        if (solutionButton) break;

        const checkButton = await waitFor(() => {
          const button = getCheckButton(activeWorkArea);
          return isUsable(button) ? button : null;
        }, 20000);

        if (!checkButton) {
          log('Check button was not found or is disabled');
          break;
        }

        clickElement(checkButton, `Проверить (${attempt}/${config.maxCheckClicks})`);
        await sleep(config.clickPauseMs);

        const solutionArea = findQuizAreaWithSolution();
        if (solutionArea) {
          activeWorkArea = solutionArea;
          break;
        }
      }

      const solutionButton = await waitFor(() => {
        let button = getSolutionButton(activeWorkArea);
        if (!button) {
          const solutionArea = findQuizAreaWithSolution();
          if (solutionArea) {
            activeWorkArea = solutionArea;
            button = getSolutionButton(activeWorkArea);
          }
        }
        return button || null;
      }, 30000);

      if (isStopRequested()) return { stopped: true };

      if (!solutionButton) {
        throw new Error('The solution button did not appear. Try increasing maxCheckClicks.');
      }

      clickElementRelaxed(solutionButton, 'Решение');
      await sleep(500);

      const confirmButton = await waitFor(() => {
        const button = getConfirmSolutionButton();
        return isUsable(button) ? button : null;
      }, 10000);

      if (isStopRequested()) return { stopped: true };

      if (confirmButton) {
        clickElement(confirmButton, 'Посмотреть решение');
      }

      const modal = await waitFor(
        () => document.querySelector('[data-test-id="author-solution-modal"], .author-solution-modal'),
        30000,
      );

      if (isStopRequested()) return { stopped: true };

      if (!modal) {
        throw new Error('The solution modal did not open.');
      }

      await sleep(500);
      const code = extractSampleSolution(modal);
      if (!code) {
        throw new Error('Could not extract sample solution text from the modal.');
      }

      const copied = await copyText(code);
      const closedEditorNotifications = await closeEditorNotifications();
      let pasted = pasteIntoEditor(code);
      const closed = await closeSolutionModal();
      if (!pasted) {
        await closeEditorNotifications();
        pasted = pasteIntoEditor(code);
      }
      const checked = await checkSolutionBeforeNext();
      if (checked) markActiveWorkAreaProcessed();
      const nextClicked = await clickNextButton();
      log(
        [
          `Cycle ${cycleNumber} done.`,
          copied ? 'Sample solution copied to clipboard.' : 'Clipboard copy was skipped or blocked.',
          closedEditorNotifications ? `Editor notifications closed: ${closedEditorNotifications}.` : 'No editor notifications found.',
          pasted ? 'Sample solution pasted into the editor.' : 'Could not paste into the editor automatically.',
          closed ? 'Solution modal closed.' : 'Could not close the solution modal automatically.',
          checked ? 'Correct solution checked.' : 'Could not run or confirm the final check.',
          nextClicked ? 'Next button clicked.' : 'Could not find an enabled next button.',
        ].join('\n'),
      );

      window.__practicumLastSampleSolution = code;
      return { code, nextClicked };
    } catch (error) {
      console.error('[PracticumAutoSolution]', error);
      log(`Error: ${error.message}`);
      throw error;
    }
  }

  async function waitForNextPage(previousUrl, cycleNumber) {
    if (isStopRequested()) return false;

    log(`Cycle ${cycleNumber}: waiting for the next page...`);
    const urlChanged = await waitFor(() => window.location.href !== previousUrl, config.nextPageWaitMs, 500);
    if (!urlChanged) {
      log('Next page did not load in time. Continuous mode paused.');
      return false;
    }

    await sleep(config.loopPauseMs);
    const taskUi = await waitFor(() => {
      activeWorkArea = null;
      const area = selectWorkArea();
      if (area && (getCheckButton(area) || getSolutionButton(area))) return true;
      return Boolean(getPassThroughPageButton() || getNextLessonUrlFromPreloadedData());
    }, config.nextPageWaitMs, 500);
    return Boolean(taskUi);
  }

  async function run() {
    if (window.__practicumAutoSolutionRunning) {
      log('Already running');
      return null;
    }

    window.__practicumAutoSolutionStopRequested = false;
    window.__practicumAutoSolutionRunning = true;

    let cycleNumber = 1;

    try {
      while (!isStopRequested()) {
        const previousUrl = window.location.href;
        const result = await runSingleCycle(cycleNumber);

        if (isStopRequested() || result?.stopped) break;
        if (!config.continuousRun) return result;

        if (result?.continueSamePage) {
          cycleNumber += 1;
          continue;
        }

        if (!result?.nextClicked) {
          await sleep(config.loopPauseMs);
          if (getNextQuizWorkArea() || getPassThroughPageButton() || getNextLessonUrlFromPreloadedData()) {
            cycleNumber += 1;
            continue;
          }
          return result;
        }

        const readyForNextCycle = await waitForNextPage(previousUrl, cycleNumber);
        if (!readyForNextCycle || isStopRequested()) break;

        cycleNumber += 1;
      }

      log(isStopRequested() ? 'Stopped.' : 'Continuous mode paused.');
      return null;
    } finally {
      window.__practicumAutoSolutionRunning = false;
    }
  }

  function stop() {
    window.__practicumAutoSolutionStopRequested = true;
    log('Stopped.');
  }

  window.practicumAutoSolution = run;
  window.practicumAutoSolutionStop = stop;
  run();
})();
