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
    autoAnswerChoiceQuizzes: true,
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
  const processedClassicTrainerAnchors = new WeakSet();
  const processedChoiceQuizzes = new WeakSet();
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
    const action = getBottomAction();
    if (action?.type === 'code') {
      activeWorkArea = action.element;
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
      '[data-test-id="theory-panel-close-button"]',
      '.trainer-footer__next-task-button',
      '.trainer-footer__next-lesson-button',
      '.next-lesson-control__button',
      '.theory-panel__theory-close-button',
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

  function getPassThroughButtonCandidates() {
    if (!config.autoSkipNoTaskPages) return [];

    const passThroughTexts = [
      'Далее',
      'Следующее задание',
      'Следующий урок',
      'К следующему уроку',
      'Продолжить',
      'Можно подробнее?',
      'Как это сделать?',
      'Перейти к заданию',
      'Готово',
    ];

    return [
      getNextButton(),
      ...document.querySelectorAll('[data-test-id^="theory-action-button-"]'),
      ...document.querySelectorAll('.content-expander__button'),
      ...[...document.querySelectorAll('button,[role="button"],a')].filter((element) =>
        passThroughTexts.includes(normalize(element.textContent)),
      ),
    ]
      .map(closestButton)
      .filter(Boolean)
      .filter((button, index, buttons) => buttons.indexOf(button) === index)
      .filter((button) => !clickedPassThroughButtons.has(button))
      .filter(isUsable);
  }

  function hasTaskControls() {
    return Boolean(
      getCheckableQuizAreas().length ||
      getNextChoiceQuizForm() ||
      document.querySelector('[data-test-id="check-task-button"]'),
    );
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(0, index);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function getChoiceQuizForms() {
    if (!config.autoAnswerChoiceQuizzes) return [];

    return [...document.querySelectorAll('form.quiz, .quiz_type_select')]
      .filter((form, index, forms) => forms.indexOf(form) === index)
      .filter((form) => !processedChoiceQuizzes.has(form))
      .filter(isVisibleQuizArea)
      .filter((form) => form.querySelector('input[type="radio"], input[type="checkbox"]'))
      .filter((form) => form.querySelector('button[type="submit"], .quiz__submit'));
  }

  function getNextChoiceQuizForm() {
    const forms = getChoiceQuizForms();
    return forms[forms.length - 1] || null;
  }

  function getClassicTrainerCodeAction() {
    const checkButton = closestButton(document.querySelector('[data-test-id="check-task-button"]'));
    const solutionButton = closestButton(document.querySelector('[data-test-id="trainer-author-solution-student-button"]'));
    const anchor = checkButton || solutionButton;
    if (!anchor) return null;

    const editor = document.querySelector('.trainer-editor, .monaco-editor, .CodeMirror, textarea');
    if (!editor) return null;

    const candidates = [
      anchor.closest('.trainer-task'),
      anchor.closest('.trainer__body'),
      anchor.closest('.trainer__lesson'),
      anchor.closest('main'),
      document.querySelector('.trainer-task'),
      document.querySelector('.trainer__body'),
      document.querySelector('main'),
      document,
    ].filter(Boolean);
    const workArea = candidates.find((area) => area.contains?.(anchor) && area.contains?.(editor)) || document;
    if (processedClassicTrainerAnchors.has(anchor) && isUsable(getNextButton())) return null;

    return { type: 'code', element: workArea, anchor };
  }

  function getLastByDocumentOrder(items) {
    return items
      .filter(Boolean)
      .sort((left, right) => {
        if (left === right) return 0;
        return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .at(-1) || null;
  }

  function getLastActionByDocumentOrder(actions) {
    return actions
      .filter((action) => action?.anchor)
      .sort((left, right) => {
        if (left.anchor === right.anchor) return 0;
        return left.anchor.compareDocumentPosition(right.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .at(-1) || null;
  }

  function getBottomAction() {
    const quizCodeArea = getNextQuizWorkArea();
    const classicCodeAction = getClassicTrainerCodeAction();
    const choiceForm = getNextChoiceQuizForm();
    const passThroughButton = getLastByDocumentOrder(getPassThroughButtonCandidates());
    const bottomTask = getLastActionByDocumentOrder([
      quizCodeArea ? { type: 'code', element: quizCodeArea, anchor: quizCodeArea } : null,
      classicCodeAction,
      choiceForm ? { type: 'choice-quiz', element: choiceForm, anchor: choiceForm } : null,
      passThroughButton ? { type: 'pass-through', element: passThroughButton, anchor: passThroughButton } : null,
    ]);

    if (bottomTask) return { type: bottomTask.type, element: bottomTask.element };

    const nextLessonUrl = getNextLessonUrlFromPreloadedData();
    if (nextLessonUrl) return { type: 'pass-through-url', url: nextLessonUrl };

    return null;
  }

  function getChoiceQuizSubmitButton(form) {
    if (!form?.querySelector) return null;

    return firstUsableOrFirst([
      form.querySelector('button[type="submit"]'),
      form.querySelector('.quiz__submit'),
      ...[...form.querySelectorAll('button,[role="button"]')].filter((element) =>
        ['Проверить', 'Ответить', 'Отправить', 'Далее', 'Продолжить'].includes(normalize(element.textContent)),
      ),
    ]);
  }

  function clickChoiceInput(input) {
    const label = input.closest?.('label') || document.querySelector(`label[for="${CSS.escape(input.id || '')}"]`);
    const target = label || input;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function answerChoiceQuiz(form) {
    const inputs = [...form.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .filter((input) => !input.disabled && input.getAttribute('aria-disabled') !== 'true');

    if (!inputs.length) return false;

    const radioInputs = inputs.filter((input) => input.type === 'radio');
    const checkboxInputs = inputs.filter((input) => input.type === 'checkbox');
    const isSingleChoice =
      radioInputs.length > 0 ||
      form.classList.contains('quiz_options-type_radio') ||
      form.getAttribute('data-test-id')?.includes('quiz-radio');
    const sourceInputs = isSingleChoice ? radioInputs : checkboxInputs;
    if (!sourceInputs.length) return false;

    const choicesCount = isSingleChoice ? 1 : randomInt(1, Math.min(sourceInputs.length, 3));
    const choices = shuffle(sourceInputs).slice(0, choicesCount);

    for (const input of choices) {
      clickChoiceInput(input);
      await sleep(250);
    }

    const submitButton = await waitFor(() => {
      const button = getChoiceQuizSubmitButton(form);
      return isUsable(button) ? button : null;
    }, 10000);

    if (!submitButton) return false;

    clickElementRelaxed(submitButton, 'Random quiz answer');
    processedChoiceQuizzes.add(form);
    await sleep(config.loopPauseMs);
    return true;
  }

  function getTheoryOnlyActionButton() {
    return getPassThroughButtonCandidates().find((button) =>
      button.matches?.('[data-test-id^="theory-action-button-"], .content-expander__button'),
    ) || null;
  }

  function getPassThroughPageButton() {
    if (!config.autoSkipNoTaskPages) return null;
    return getPassThroughButtonCandidates()[0] || null;
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
    const target = closestButton(element) || element;
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

  function normalizeFilePath(path) {
    return normalize(path)
      .replace(/^file:\/+/, '')
      .replace(/^\/+/, '')
      .replace(/\\/g, '/')
      .replace(/^workspace\//, '');
  }

  function normalizeCodeForCompare(code) {
    return (code || '').replace(/\r\n/g, '\n').replace(/\s+$/g, '');
  }

  function shouldSkipSolutionFile(path) {
    return /\.(css|js|json)$/i.test(normalizeFilePath(path));
  }

  function getModalFilePanels(modal) {
    return [...modal.querySelectorAll('.author-solution-modal__code-tabs-panel')]
      .filter((panel) => panel.querySelector('.tab__text'));
  }

  function getPanelFileTabs(panel) {
    return [...panel.querySelectorAll('.tab')]
      .map((tab) => ({
        tab,
        path: normalizeFilePath(tab.querySelector('.tab__text')?.textContent || ''),
      }))
      .filter((item) => item.path);
  }

  function getActivePanelContent(panel) {
    return panel.querySelector('.tabs__item-content_visible') || panel;
  }

  async function selectModalFileTab(panel, filePath) {
    const normalizedPath = normalizeFilePath(filePath);
    const item = getPanelFileTabs(panel).find((candidate) => candidate.path === normalizedPath);
    if (!item) return false;

    clickElementRelaxed(item.tab, `Solution file tab: ${normalizedPath}`);
    await sleep(250);
    return true;
  }

  async function extractSampleSolutionFiles(modal) {
    const panels = getModalFilePanels(modal);
    if (panels.length < 2) return [];

    const currentPanel = panels[0];
    const targetPanel = panels[1];
    const paths = [
      ...new Set(getPanelFileTabs(targetPanel).map((item) => item.path)),
    ].filter((path) => !shouldSkipSolutionFile(path));
    const files = [];

    for (const path of paths) {
      if (isStopRequested()) break;

      await selectModalFileTab(currentPanel, path);
      await selectModalFileTab(targetPanel, path);
      await sleep(150);

      const currentCode = extractCodeFromPanel(getActivePanelContent(currentPanel));
      const targetCode = extractCodeFromPanel(getActivePanelContent(targetPanel));

      if (normalizeCodeForCompare(currentCode) !== normalizeCodeForCompare(targetCode)) {
        files.push({ path, code: targetCode, currentCode });
      }
    }

    return files;
  }

  function formatSolutionFilesForClipboard(files) {
    return files
      .map((file) => `# ${file.path}\n${file.code}`)
      .join('\n\n');
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
      ...new Set(areas.flatMap((area) => [
        ...area.querySelectorAll?.('.trainer-editor__code-editor_opened .monaco-editor') || [],
        ...area.querySelectorAll?.('.monaco-editor') || [],
      ])),
    ].filter(isVisibleQuizArea);
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
    const scopedModel = editorNodes
      .map((node) => node.getAttribute('data-uri'))
      .filter(Boolean)
      .map((uri) => models.find((model) => model.uri?.toString?.() === uri || String(model.uri || '') === uri))
      .find(Boolean);

    if (scopedModel?.setValue) {
      scopedModel.setValue(text);
      return true;
    }

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

  function getProjectFileNodes() {
    const nodes = [...document.querySelectorAll('.tree-node-file-system__name')]
      .map((node) => {
        const label = normalize(
          node.querySelector('.files-tree__node-name-container .element-hint__wrapper')?.textContent ||
          node.querySelector('.files-tree__node-name-container')?.textContent ||
          '',
        );
        if (!label) return null;

        const styleLevel = node.style?.getPropertyValue('--nesting-level') || '';
        const attrLevel = node.getAttribute('style')?.match(/--nesting-level:\s*(\d+)/)?.[1] || '';
        const level = Number(styleLevel || attrLevel || 1);
        const isFolder = Boolean(
          node.querySelector('.files-tree__node-folder-icon, .icon-folder, .tree-node-file-system__name-arrow'),
        );

        return { node, label, level, isFolder };
      })
      .filter(Boolean);

    const stack = [];
    const files = [];

    for (const item of nodes) {
      stack[item.level - 1] = item.label;
      stack.length = item.level;

      if (!item.isFolder) {
        files.push({
          path: normalizeFilePath(stack.join('/')),
          node: item.node,
          label: item.label,
        });
      }
    }

    return files;
  }

  async function expandProjectTree() {
    const expandButtons = [...document.querySelectorAll('button[aria-label="Р Р°Р·РІРµСЂРЅСѓС‚СЊ"], button[aria-label="Развернуть"]')]
      .map(closestButton)
      .filter(Boolean)
      .filter(isUsable);

    for (const button of expandButtons) {
      clickElementRelaxed(button, 'Expand file tree');
      await sleep(300);
    }
  }

  function getMonacoModelForPath(path) {
    const normalizedPath = normalizeFilePath(path);
    const models = window.monaco?.editor?.getModels?.() || [];

    return models.find((model) => {
      const uri = normalizeFilePath(model.uri?.toString?.() || String(model.uri || ''));
      return uri === normalizedPath || uri.endsWith(`/${normalizedPath}`);
    }) || null;
  }

  function getActiveMonacoPath() {
    const activeEditor = document.querySelector('.trainer-editor__code-editor_opened .monaco-editor');
    const visibleEditor = [...document.querySelectorAll('.monaco-editor')].find(isVisibleQuizArea);
    return normalizeFilePath(activeEditor?.getAttribute('data-uri') || visibleEditor?.getAttribute('data-uri') || '');
  }

  function isActiveMonacoPath(path) {
    const normalizedPath = normalizeFilePath(path);
    const activePath = getActiveMonacoPath();
    return activePath === normalizedPath || activePath.endsWith(`/${normalizedPath}`);
  }

  async function selectProjectFile(path) {
    const normalizedPath = normalizeFilePath(path);
    let file = getProjectFileNodes().find((item) => item.path === normalizedPath);

    if (getMonacoModelForPath(normalizedPath) || isActiveMonacoPath(normalizedPath)) return true;

    if (!file) {
      await expandProjectTree();
      file = getProjectFileNodes().find((item) => item.path === normalizedPath);
    }

    if (!file) return false;

    clickElementRelaxed(file.node, `Open file: ${normalizedPath}`);
    file.node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const opened = await waitFor(() => {
      const model = getMonacoModelForPath(normalizedPath);
      if (model) return model;

      return isActiveMonacoPath(normalizedPath) ? true : null;
    }, 10000, 250);

    await sleep(250);
    return Boolean(opened);
  }

  function setMonacoFileValue(path, code) {
    const normalizedPath = normalizeFilePath(path);
    const model = getMonacoModelForPath(normalizedPath);
    const editor = (window.monaco?.editor?.getEditors?.() || []).find((candidate) => {
      const candidateModel = candidate.getModel?.();
      const uri = normalizeFilePath(candidateModel?.uri?.toString?.() || String(candidateModel?.uri || ''));
      return uri === normalizedPath || uri.endsWith(`/${normalizedPath}`);
    });

    const targetModel = editor?.getModel?.() || model;

    if (targetModel?.setValue) {
      targetModel.setValue(code);
      editor.focus?.();
      const node = editor?.getDomNode?.();
      node?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code }));
      node?.dispatchEvent(new Event('change', { bubbles: true }));
      node?.querySelector?.('textarea')?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code }));
      return true;
    }

    return false;
  }

  async function pasteSolutionFilesIntoEditor(files) {
    if (!config.pasteIntoEditor || !files.length) return false;

    let pastedCount = 0;

    for (const file of files) {
      if (isStopRequested()) break;

      const opened = await selectProjectFile(file.path);
      if (!opened) {
        console.warn('[PracticumAutoSolution] Could not find file in tree:', file.path);
        continue;
      }

      const pasted = setMonacoFileValue(file.path, file.code);
      if (pasted) pastedCount += 1;
      if (!pasted) {
        console.warn('[PracticumAutoSolution] Could not paste into file:', file.path);
      }
      await sleep(400);
    }

    return pastedCount > 0;
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
    const classicCodeAction = quizArea ? null : getClassicTrainerCodeAction();
    const checkArea = quizArea || classicCodeAction?.element || activeWorkArea || document;
    activeWorkArea = checkArea;
    const laterQuizCountBeforeCheck = quizArea ? getCheckableQuizAreasAfter(quizArea).length : 0;

    await sleep(700);
    const checkButton = await waitFor(() => {
      const button = getCheckButton(checkArea) || getCheckButton(document);
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

    const action = getBottomAction();
    if (action?.type === 'code' || action?.type === 'choice-quiz') return false;

    const nextButton = await waitFor(() => {
      const button = getNextButton();
      return isUsable(button) ? button : null;
    }, 15000);

    if (!nextButton) return false;

    clickElement(nextButton, 'Далее');
    clickedPassThroughButtons.add(closestButton(nextButton));
    return true;
  }

  function markActiveWorkAreaProcessed() {
    if (activeWorkArea?.matches?.('.quiz__coding')) {
      processedQuizAreas.add(activeWorkArea);
      lastProcessedQuizArea = activeWorkArea;
      activeWorkArea = null;
      return;
    }

    const classicCodeAction = getClassicTrainerCodeAction();
    if (classicCodeAction) {
      processedClassicTrainerAnchors.add(classicCodeAction.anchor);
      if (activeWorkArea === classicCodeAction.element) activeWorkArea = null;
    }
  }

  async function handlePassThroughPage(cycleNumber = 1, providedButton = null) {
    const previousUrl = window.location.href;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (isStopRequested()) return { stopped: true };

      const button = await waitFor(() => {
        const action = getBottomAction();
        const candidate = attempt === 1 && providedButton ? providedButton : action?.type === 'pass-through' ? action.element : getPassThroughPageButton();
        return isUsable(candidate) ? candidate : null;
      }, 5000);

      if (!button) break;

      clickedPassThroughButtons.add(closestButton(button));
      clickElementRelaxed(button, `No-task page action (${attempt}/5)`);
      await sleep(config.loopPauseMs);

      if (window.location.href !== previousUrl) {
        return { nextClicked: true, passThrough: true };
      }

      const action = getBottomAction();
      if (action?.type === 'code' || action?.type === 'choice-quiz') {
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

  async function handleChoiceQuiz(cycleNumber = 1, providedForm = null) {
    const form = providedForm || getNextChoiceQuizForm();
    if (!form) return { nextClicked: false, choiceQuiz: true };

    log(`Cycle ${cycleNumber}: answering a choice quiz...`);
    const answered = await answerChoiceQuiz(form);
    if (!answered) return { nextClicked: false, choiceQuiz: true };

    const nextButton = await waitFor(() => {
      const button = getNextButton();
      return isUsable(button) ? button : null;
    }, 10000);

    if (nextButton) {
      clickElementRelaxed(nextButton, 'Далее после опроса');
      return { nextClicked: true, choiceQuiz: true };
    }

    const nextLessonUrl = getNextLessonUrlFromPreloadedData();
    if (nextLessonUrl) {
      log(`Cycle ${cycleNumber}: choice quiz answered, opening next lesson directly.`);
      window.location.assign(nextLessonUrl);
      return { nextClicked: true, choiceQuiz: true };
    }

    return { nextClicked: false, choiceQuiz: true, continueSamePage: Boolean(getNextChoiceQuizForm()) };
  }

  async function runSingleCycle(cycleNumber = 1) {
    try {
      if (isStopRequested()) return { stopped: true };

      log(`Cycle ${cycleNumber}: waiting for the task UI...`);
      const initialUi = await waitFor(() => {
        const action = getBottomAction();
        if (action?.type === 'code') {
          activeWorkArea = action.element;
          return action;
        }
        if (action?.type === 'choice-quiz' || action?.type === 'pass-through' || action?.type === 'pass-through-url') {
          return action;
        }

        const area = selectWorkArea();
        if (area && (getCheckButton(area) || getSolutionButton(area))) {
          return { type: 'task', element: area };
        }
        return null;
      }, 30000);
      if (isStopRequested()) return { stopped: true };

      if (initialUi?.type === 'choice-quiz') {
        return handleChoiceQuiz(cycleNumber, initialUi.element);
      }

      if (initialUi?.type === 'pass-through' || initialUi?.type === 'pass-through-url') {
        return handlePassThroughPage(cycleNumber, initialUi.element);
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
      const solutionFiles = await extractSampleSolutionFiles(modal);
      const code = solutionFiles.length ? formatSolutionFilesForClipboard(solutionFiles) : extractSampleSolution(modal);
      if (!code && !solutionFiles.length) {
        throw new Error('Could not extract sample solution text from the modal.');
      }

      const copied = await copyText(code);
      const closedEditorNotifications = await closeEditorNotifications();

      let pasted = false;
      let closed = false;

      if (solutionFiles.length) {
        closed = await closeSolutionModal();
        await closeEditorNotifications();
        pasted = await pasteSolutionFilesIntoEditor(solutionFiles);
      } else {
        pasted = pasteIntoEditor(code);
        closed = await closeSolutionModal();
        if (!pasted) {
          await closeEditorNotifications();
          pasted = pasteIntoEditor(code);
        }
      }

      if (!pasted && !solutionFiles.length) {
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
          solutionFiles.length ? `Changed files found: ${solutionFiles.length}.` : 'Single-file solution detected.',
          pasted ? 'Sample solution pasted into the editor.' : 'Could not paste into the editor automatically.',
          closed ? 'Solution modal closed.' : 'Could not close the solution modal automatically.',
          checked ? 'Correct solution checked.' : 'Could not run or confirm the final check.',
          nextClicked ? 'Next button clicked.' : 'Could not find an enabled next button.',
        ].join('\n'),
      );

      window.__practicumLastSampleSolution = solutionFiles.length ? solutionFiles : code;
      return { code, solutionFiles, nextClicked };
    } catch (error) {
      console.error('[PracticumAutoSolution]', error);
      log(`Error: ${error.message}`);
      throw error;
    }
  }

  async function waitForNextPage(previousUrl, cycleNumber) {
    if (isStopRequested()) return false;

    log(`Cycle ${cycleNumber}: waiting for the next task...`);
    await sleep(config.loopPauseMs);
    const nextAction = await waitFor(() => {
      activeWorkArea = null;
      const action = getBottomAction();
      if (!action) return null;
      if (window.location.href === previousUrl && action.type === 'pass-through-url') return null;
      return action;
    }, config.nextPageWaitMs, 500);

    if (!nextAction) {
      log('Next task did not appear in time. Continuous mode paused.');
      return false;
    }

    return true;
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
          if (getBottomAction()) {
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
