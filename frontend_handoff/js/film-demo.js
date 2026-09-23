// Deterministic, query-guarded states used to record the real Hectra MVP.
// This file intentionally does nothing unless workspace.html is opened with
// ?film_demo=state, ?film_demo=edit, ?film_demo=history, or
// ?film_demo=workflow.
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('film_demo');
  if (!['state', 'edit', 'history', 'workflow'].includes(mode)) return;
  const initialFilmAt = Math.max(0, Number(params.get('film_at')) || 0);
  const initialCaptureFinalState = params.get('film_capture') === '1';
  const initialFilmRun = params.get('film_run') || '';
  const initialPreloadOnly = params.get('film_preload') === '1';
  let activeCaptureFinalState = initialCaptureFinalState;
  let activeFilmRun = initialFilmRun;
  let demoClock = initialFilmAt;
  let demoClockStamp = performance.now();
  let demoPaused = false;
  let demoGeneration = 0;
  let buildQueue = Promise.resolve();
  let workflowInstantRender = false;
  let workflowMotionRaf = 0;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const mix = (from, to, value) => from + (to - from) * value;
  const ease = value => 1 - Math.pow(1 - clamp(value), 3);
  const easeInOut = value => {
    const x = clamp(value);
    return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  };

  const INITIAL_SECTIONS = [
    {
      id: 'step-1',
      title: '1. Start with initial parameters.',
      content: 'Choose a starting point for the model.',
    },
    {
      id: 'step-2',
      title: '2. Calculate how the error changes.',
      content: 'Measure how the error changes around the current parameters.',
    },
    {
      id: 'step-3',
      title: '3. Update the parameters to reduce the error.',
      content: 'Move the parameters in the direction that lowers the error.',
    },
  ];

  const UPDATED_STEP = {
    id: 'step-2',
    title: '2. Imagine standing on a hill in fog.',
    content: [
      'The slope shows which direction goes downhill, so you take a small step in that direction.',
    ].join('\n'),
  };

  const WORKFLOW_SECTIONS = [
    {
      id: 'definition',
      title: '1. Definition',
      content: 'Gradient descent updates parameters in the direction that reduces the loss.',
    },
    {
      id: 'intuition',
      title: '2. Intuition',
      content: 'The gradient indicates how the loss changes near the current point.',
    },
    {
      id: 'formula',
      title: '3. Formula',
      content: '`θₜ₊₁ = θₜ − η∇L(θₜ)`',
    },
    {
      id: 'derivation',
      title: '4. Step-by-step derivation',
      content: [
        'For `L(θ) = (θ − 3)²`, with `θ₀ = 0` and `η = 0.1`:',
        '',
        '- `∇L(θ) = 2(θ − 3)`',
        '- `∇L(θ₀) = −6`',
        '- `θ₁ = 0 − 0.1(−6) = 0.6`',
      ].join('\n'),
    },
    {
      id: 'common-mistake',
      title: '5. Common mistake',
      content: 'A learning rate that is too large can overshoot the minimum.',
    },
    {
      id: 'conclusion',
      title: '6. Conclusion',
      content: 'The gradient chooses the direction; the learning rate controls the step size.',
    },
  ];

  const WORKFLOW_EXPANDED_INTUITION = {
    id: 'intuition',
    title: '2. Intuition',
    content: 'Imagine standing on a hill in fog. The slope shows the downhill direction; the learning rate controls the size of the step.',
  };

  const WORKFLOW_FIRST_EDIT = 'In point 2, add an intuitive example. Keep the other sections unchanged.';
  const WORKFLOW_INITIAL_PROMPT = 'Create Gradient Descent — Working Notes with six concise sections.';
  /*
   * 28800ms, re-cut from 33000ms. The reduction is taken entirely out of the
   * four beats that show nothing about the product — typing and waiting —
   * and part of it is given back to the states that are the product:
   *
   *              typing  wait  answer  onboard  typing  wait  diff  history  final
   *   33000 cut    3.6   3.2    4.5      2.8      3.7   3.6   5.5     -       3.5
   *   28800 cut    2.0   1.7    4.2      2.2      2.3   1.7   5.0    4.3      3.4
   *
   * The new history beat (21100 -> 25400) is the point of the re-cut: it steps
   * back to version 1 and forward to version 2 through the product's own
   * version bar, so "Hectra separates current state from previous states" is
   * shown rather than asserted in a caption.
   */
  const WORKFLOW_STAGE_TIMES = Object.freeze({
    initialSubmit: 3000,
    initialAnswer: 4700,
    showEditOnboarding: 8900,
    confirmEditOnboarding: 11100,
    editSubmit: 14400,
    editApplied: 16100,
    showPreviousVersion: 21100,
    showLatestVersion: 23600,
    acceptEdit: 25400,
    finalHoldStart: 26500,
    nominalEnd: 28800,
  });

  const EDIT_INSTRUCTION = 'In point 2, explain how the error changes with an intuitive example. Keep points 1 and 3 unchanged.';
  const INITIAL_PROMPT = 'Create a concise three-step explanation of gradient descent.';
  const FIXED_TIME = new Date('2026-07-19T10:30:00+05:00');

  if (mode === 'workflow') {
    window.__HECTRA_FILM_DEMO_TIMING__ = { ...WORKFLOW_STAGE_TIMES };
  }

  function cloneSections(sections) {
    return sections.map(section => ({ ...section }));
  }

  function setInput(text) {
    if (userInput.value === text) return;
    userInput.value = text;
    userInput.style.height = 'auto';
    userInput.style.height = `${Math.min(userInput.scrollHeight, 150)}px`;
  }

  function sampleDemoClock() {
    const now = performance.now();
    if (!demoPaused) {
      demoClock += Math.max(0, Math.min(64, now - demoClockStamp));
    }
    demoClockStamp = now;
    return demoClock;
  }

  /*
   * Each cue lands 140ms before the stage it triggers, halved from 280ms. The
   * gap exists so the pointer is seen arriving rather than teleporting onto
   * the result; at 280ms it had stopped being anticipation and started being
   * a wait. The stage times are unchanged - this moves the pointer later, it
   * does not move the product.
   */
  const WORKFLOW_CLICK_CUES = [
    { click: 2860, selector: '#send-btn' },
    { click: 10960, selector: '.edit-onboarding-secondary' },
    { click: 14260, selector: '#send-btn' },
    { click: 20960, selector: '.version-bar-fixed [data-action="prev-version"]' },
    { click: 23460, selector: '.version-bar-fixed [data-action="next-version"]' },
    { click: 25260, selector: '.version-bar-fixed .version-accept-btn' },
  ];

  function latchWorkflowClickPosition(click) {
    const cue = WORKFLOW_CLICK_CUES.find(item => item.click === click);
    const rect = cue
      ? document.querySelector(cue.selector)?.getBoundingClientRect()
      : null;
    if (!cue || !rect || rect.width <= 0 || rect.height <= 0) return;
    cue.x = rect.left + rect.width / 2;
    cue.y = rect.top + rect.height / 2;
  }

  function typedSlice(text, time, from, to) {
    const progress = easeInOut(clamp((time - from) / Math.max(1, to - from), 0, 1));
    return text.slice(0, Math.round(text.length * progress));
  }

  function renderWorkflowTyping(time) {
    if (time >= 400 && time < WORKFLOW_STAGE_TIMES.initialSubmit) {
      setInput(typedSlice(WORKFLOW_INITIAL_PROMPT, time, 400, 2600));
    } else if (
      time >= 11700 &&
      time < WORKFLOW_STAGE_TIMES.editSubmit &&
      HectraState.isEditMode
    ) {
      setInput(typedSlice(WORKFLOW_FIRST_EDIT, time, 11700, 14000));
    }
    renderWorkflowCaret(time);
  }

  let filmDemoCaret = null;
  let filmDemoMeasure = null;

  /*
   * Native textarea caret blinking belongs to the browser clock and can land
   * in a different state in every rendered frame. The film uses a visually
   * identical one whose position and blink phase are pure functions of the
   * workflow time.
   */
  function renderWorkflowCaret(time) {
    if (mode !== 'workflow') return;
    if (!filmDemoCaret) {
      filmDemoCaret = document.createElement('i');
      filmDemoCaret.className = 'film-demo-caret';
      filmDemoCaret.setAttribute('aria-hidden', 'true');
      document.body.appendChild(filmDemoCaret);
    }
    if (!filmDemoMeasure) {
      filmDemoMeasure = document.createElement('canvas').getContext('2d');
    }

    const value = userInput.value;
    const isFirstInput =
      time >= 400 && time < WORKFLOW_STAGE_TIMES.initialSubmit;
    const isEditInput =
      time >= 11700 && time < WORKFLOW_STAGE_TIMES.editSubmit;
    if (!value || (!isFirstInput && !isEditInput)) {
      filmDemoCaret.style.opacity = '0';
      return;
    }

    const style = getComputedStyle(userInput);
    const rect = userInput.getBoundingClientRect();
    filmDemoMeasure.font = style.font;
    const textWidth = filmDemoMeasure.measureText(value).width;
    const left = Math.min(
      rect.right - 1,
      rect.left + (parseFloat(style.paddingLeft) || 0) + textWidth
    );
    const top = rect.top + (parseFloat(style.paddingTop) || 0);
    const typing =
      (time >= 400 && time < 2600) ||
      (time >= 11700 && time < 14000);
    const blinkOn = typing || (Math.floor(time / 530) % 2 === 0);

    filmDemoCaret.style.left = `${Math.round(left * 2) / 2}px`;
    filmDemoCaret.style.top = `${Math.round(top * 2) / 2}px`;
    filmDemoCaret.style.height = `${parseFloat(style.lineHeight) || 22}px`;
    filmDemoCaret.style.opacity = blinkOn ? '1' : '0';
  }

  function renderWorkflowEntrances(time) {
    const reveal = (element, from) => {
      if (!element) return;
      const progress = ease(clamp((time - from) / 320, 0, 1));
      element.style.opacity = String(progress);
      element.style.transform = `translateY(${(10 * (1 - progress)).toFixed(2)}px)`;
    };
    reveal(document.querySelector('.msg-user'), WORKFLOW_STAGE_TIMES.initialSubmit);
    reveal(document.querySelector('.msg-ai'), WORKFLOW_STAGE_TIMES.initialAnswer);

    const overlay = document.querySelector('.edit-onboarding-overlay');
    if (overlay) {
      const progress = ease(clamp(
        (time - WORKFLOW_STAGE_TIMES.showEditOnboarding) / 180,
        0,
        1
      ));
      const card = overlay.querySelector('.edit-onboarding-card');
      overlay.style.transition = 'none';
      overlay.style.opacity = String(progress);
      if (card) {
        card.style.transition = 'none';
        card.style.opacity = String(progress);
        card.style.transform =
          `translateY(${(8 * (1 - progress)).toFixed(2)}px) scale(${(.98 + .02 * progress).toFixed(4)})`;
      }
    }
  }

  function ensureWorkflowMotion() {
    if (mode !== 'workflow') return;
    let pulse = document.getElementById('film-demo-click-pulse');
    if (!pulse) {
      pulse = document.createElement('div');
      pulse.id = 'film-demo-click-pulse';
      pulse.className = 'film-demo-click-pulse';
      pulse.setAttribute('aria-hidden', 'true');
      pulse.innerHTML = '<i></i>';
      document.body.appendChild(pulse);
    }
    if (workflowMotionRaf) return;

    const renderMotion = () => {
      const time = sampleDemoClock();
      renderWorkflowTyping(time);
      renderWorkflowEntrances(time);

      /*
       * The whole click gesture runs at 0.55x of what it did: 760ms of pulse
       * for a 0ms event read as the film waiting for its own cursor. Every
       * duration below is scaled by the same factor, so the shape of the
       * gesture - anticipate, press, release, ring out - is unchanged and only
       * its tempo moved.
       */
      const cue = WORKFLOW_CLICK_CUES.find(
        item => time >= item.click - 132 && time < item.click + 286
      );
      if (!cue) {
        pulse.style.opacity = '0';
        workflowMotionRaf = requestAnimationFrame(renderMotion);
        return;
      }

      const target = document.querySelector(cue.selector);
      const rect = target?.getBoundingClientRect();
      /*
       * Resolve the point on every rendered frame while the target exists.
       * Remotion workers may receive their first frame just after cue.click;
       * relying on an earlier frame to have cached x/y made the ripple vanish
       * for those workers.
       */
      if (rect && rect.width > 0 && rect.height > 0) {
        cue.x = rect.left + rect.width / 2;
        cue.y = rect.top + rect.height / 2;
      }
      if (!Number.isFinite(cue.x) || !Number.isFinite(cue.y)) {
        pulse.style.opacity = '0';
        workflowMotionRaf = requestAnimationFrame(renderMotion);
        return;
      }

      const before = ease(clamp((time - (cue.click - 132)) / 110, 0, 1));
      const after = ease(clamp((time - (cue.click + 44)) / 242, 0, 1));
      const opacity = Math.min(before, 1 - after);
      const press = easeInOut(clamp((time - (cue.click - 66)) / 99, 0, 1));
      const release = ease(clamp((time - cue.click) / 231, 0, 1));
      const coreScale = time < cue.click
        ? mix(.62, .9, press)
        : mix(.9, 1.28, release);
      const ringScale = mix(.72, 2.35, ease(clamp((time - cue.click) / 264, 0, 1)));
      const ringOpacity = time < cue.click
        ? mix(0, .8, press)
        : 1 - ease(clamp((time - cue.click) / 237, 0, 1));

      pulse.style.left = `${cue.x}px`;
      pulse.style.top = `${cue.y}px`;
      pulse.style.opacity = String(opacity);
      pulse.style.setProperty('--click-core-scale', String(coreScale));
      pulse.style.setProperty('--click-ring-scale', String(ringScale));
      pulse.style.setProperty('--click-ring-opacity', String(ringOpacity));
      workflowMotionRaf = requestAnimationFrame(renderMotion);
    };

    workflowMotionRaf = requestAnimationFrame(renderMotion);
  }

  function waitForStage(stageTime, generation) {
    if (activeCaptureFinalState) {
      return Promise.resolve(generation === demoGeneration);
    }
    return new Promise(resolve => {
      const check = () => {
        if (generation !== demoGeneration) {
          resolve(false);
          return;
        }
        if (sampleDemoClock() >= stageTime) {
          resolve(true);
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  function persistDemoState() {
    HectraState.getAllSessionMeta = () => [{
      id: HectraState.sessionId,
      title: HectraState.sessionTitle,
      updatedAt: FIXED_TIME.getTime(),
    }];
    renderSidebarSessions();
  }

  function setDemoPaused(nextPaused) {
    sampleDemoClock();
    demoPaused = nextPaused;
  }

  function markDemoReady(generation) {
    if (generation !== demoGeneration) return;
    if (mode === 'history') chatScroll.scrollTop = chatScroll.scrollHeight;
    else if (mode !== 'workflow') chatScroll.scrollTop = 0;
    window.__HECTRA_FILM_DEMO_READY__ = true;
    document.documentElement.dataset.filmDemoReady = 'true';
    window.parent?.postMessage({
      type: 'hectra-film-demo-ready',
      mode,
      run: activeFilmRun,
    }, '*');
  }

  function settleViewport(generation) {
    if (generation !== demoGeneration) return;
    requestAnimationFrame(() => {
      if (generation !== demoGeneration) return;
      requestAnimationFrame(() => {
        markDemoReady(generation);
      });
    });
  }

  async function renderWorkflowDocument(assistantMessage, generation, options = {}) {
    const {
      updatedIds = [],
      deletedIds = [],
      oldSnapshot = null,
      showDiff = false,
      keepEditMode = true,
      resetScroll = true,
    } = options;

    if (workflowInstantRender) {
      const responseEl = document.getElementById(
        `ai-response-${assistantMessage.msgIndex}`
      );
      const contentEl = responseEl?.querySelector(':scope > .response-content');
      contentEl?.replaceChildren();
      contentEl?.classList.remove('is-hidden');
      if (responseEl) {
        responseEl.classList.remove('is-resizing');
        responseEl.style.height = '';
      }
    }

    await HectraRenderer.renderAIContent(
      assistantMessage.msgIndex,
      HectraState.getDocumentSectionsArray(),
      updatedIds,
      deletedIds,
      {
        oldSnapshot,
        showDiff,
      }
    );
    if (generation !== demoGeneration) return false;

    HectraRenderer.setChangelogs(
      assistantMessage.msgIndex,
      assistantMessage.changelogs || []
    );
    HectraRenderer.setEditButton(
      assistantMessage.msgIndex,
      true,
      () => enterEditMode(assistantMessage.msgIndex)
    );

    if (keepEditMode) {
      enterEditMode(assistantMessage.msgIndex);
    } else {
      exitEditMode();
    }
    setInput('');
    setStatus('ready');
    if (resetScroll) chatScroll.scrollTop = 0;
    return true;
  }

  function createWorkflowStages(generation) {
    let assistantMessage = null;
    const render = options => {
      if (!assistantMessage) throw new Error('Workflow document is not ready');
      return renderWorkflowDocument(assistantMessage, generation, options);
    };

    /*
     * Version navigation, along the same path app.js takes for the version
     * bar buttons. Called instead of .click() so a scrub into the middle of
     * the scene - where every stage is replayed back to back - cannot leave
     * two async click handlers racing, and cannot leave the document on the
     * old version when Accept runs.
     */
    const showVersion = async versionIndex => {
      const msgIndex = assistantMessage.msgIndex;
      const msg = HectraState.uiMessages[msgIndex];
      if (!msg?.versions || versionIndex < 0 || versionIndex >= msg.versions.length) {
        return generation === demoGeneration;
      }
      HectraState.restoreVersion(msgIndex, versionIndex);
      // Through renderWorkflowDocument, not renderAIContent directly: the
      // renderer's swap animation hides the response for ~330ms, which a
      // seek into this beat would otherwise freeze on an empty block.
      return render({
        oldSnapshot: HectraState.getPreviousSnapshot(msgIndex),
        showDiff: Boolean(HectraState.getPreviousSnapshot(msgIndex)),
        keepEditMode: false,
        resetScroll: false,
      });
    };

    return [
      {
        time: WORKFLOW_STAGE_TIMES.initialSubmit,
        name: 'initial-submit',
        run: async () => {
          latchWorkflowClickPosition(2860);
          const userMessage = HectraState.addUserMessage(WORKFLOW_INITIAL_PROMPT);
          userMessage.timestamp = FIXED_TIME;
          HectraRenderer.appendUserBubble(chatContainer, userMessage, { scroll: false });
          setInput('');
          setStatus('thinking');
          chatScroll.scrollTop = 0;
          return generation === demoGeneration;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.initialAnswer,
        name: 'initial-answer',
        run: async () => {
          const initialSections = cloneSections(WORKFLOW_SECTIONS);
          const rawDocument = initialSections
            .map(section => `## ${section.title} [#${section.id}]\n${section.content}`)
            .join('\n\n');
          assistantMessage = HectraState.addAIMessage(rawDocument, initialSections, []);
          assistantMessage.timestamp = FIXED_TIME;
          HectraRenderer.createAIMessageBlock(chatContainer, assistantMessage.msgIndex);
          await HectraRenderer.renderAIContent(
            assistantMessage.msgIndex,
            HectraState.getDocumentSectionsArray(),
            initialSections.map(section => section.id)
          );
          if (generation !== demoGeneration) return false;
          HectraRenderer.setEditButton(
            assistantMessage.msgIndex,
            true,
            () => enterEditMode(assistantMessage.msgIndex)
          );
          exitEditMode();
          setInput('');
          setStatus('ready');
          chatScroll.scrollTop = 0;
          return generation === demoGeneration;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.showEditOnboarding,
        name: 'show-edit-onboarding',
        run: async () => {
          const editButton = document.querySelector(
            `.msg-ai[data-msg-index="${assistantMessage.msgIndex}"] .edit-trigger`
          );
          if (!editButton) throw new Error('Workflow Edit button is not available');
          editButton.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
          HectraRenderer.showEditOnboarding(editButton, {
            onClose: () => {
              enterEditMode(assistantMessage.msgIndex);
              setInput('');
              chatScroll.scrollTop = chatScroll.scrollHeight;
            },
          });
          return generation === demoGeneration;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.confirmEditOnboarding,
        name: 'confirm-edit-onboarding',
        run: async () => {
          latchWorkflowClickPosition(10960);
          const confirmButton = document.querySelector('.edit-onboarding-secondary');
          if (confirmButton) confirmButton.click();
          else enterEditMode(assistantMessage.msgIndex);
          setInput('');
          return generation === demoGeneration;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.editSubmit,
        name: 'edit-submit',
        run: async () => {
          latchWorkflowClickPosition(14260);
          setInput('');
          setStatus('thinking');
          chatScroll.scrollTop = chatScroll.scrollHeight;
          return generation === demoGeneration;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.editApplied,
        name: 'edit-applied',
        run: async () => {
          const result = HectraState.applyEdit(
            [{ ...WORKFLOW_EXPANDED_INTUITION }],
            [],
            ['Updated section 2: added an intuitive hill-and-slope example.']
          );
          if (!result) throw new Error('Workflow edit could not be applied');
          const rendered = await render({
            updatedIds: result.updatedIds,
            deletedIds: result.deletedIds,
            oldSnapshot: HectraState.getPreviousSnapshot(assistantMessage.msgIndex),
            showDiff: true,
            keepEditMode: false,
            resetScroll: false,
          });
          if (!rendered || generation !== demoGeneration) return false;
          const target = document.querySelector(
            `#ai-response-${assistantMessage.msgIndex} .ai-section[data-sec-id="intuition"]`
          );
          if (target) {
            requestAnimationFrame(() => {
              const targetRect = target.getBoundingClientRect();
              const scrollRect = chatScroll.getBoundingClientRect();
              const targetTop =
                chatScroll.scrollTop +
                targetRect.top -
                scrollRect.top -
                Math.max(20, (chatScroll.clientHeight - targetRect.height) * .42);
              chatScroll.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
            });
          }
          return true;
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.showPreviousVersion,
        name: 'show-previous-version',
        run: async () => {
          latchWorkflowClickPosition(20960);
          return showVersion(0);
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.showLatestVersion,
        name: 'show-latest-version',
        run: async () => {
          latchWorkflowClickPosition(23460);
          const msg = HectraState.uiMessages[assistantMessage.msgIndex];
          return showVersion((msg?.versions?.length || 1) - 1);
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.acceptEdit,
        name: 'accept-edit',
        run: async () => {
          latchWorkflowClickPosition(25260);
          HectraState.acceptVersion(assistantMessage.msgIndex);
          return render({ keepEditMode: false, resetScroll: false });
        },
      },
      {
        time: WORKFLOW_STAGE_TIMES.finalHoldStart,
        name: 'final-accepted-state',
        run: async () => {
          exitEditMode();
          setInput('');
          setStatus('ready');
          return generation === demoGeneration;
        },
      },
    ];
  }

  async function runWorkflow(generation) {
    const stages = createWorkflowStages(generation);
    let stageIndex = 0;

    while (
      stageIndex < stages.length &&
      (activeCaptureFinalState || demoClock >= stages[stageIndex].time)
    ) {
      workflowInstantRender = true;
      let completed = false;
      try {
        completed = await stages[stageIndex].run();
      } finally {
        workflowInstantRender = false;
      }
      if (!completed) return;
      stageIndex += 1;
    }

    persistDemoState();
    if (stageIndex > 0) {
      setTimeout(() => markDemoReady(generation), 180);
    } else {
      settleViewport(generation);
    }
    if (activeCaptureFinalState) return;

    while (stageIndex < stages.length) {
      const stage = stages[stageIndex];
      if (!await waitForStage(stage.time, generation)) return;
      if (!await stage.run()) return;
      stageIndex += 1;
    }
  }

  async function buildDemo(options, generation) {
    if (generation !== demoGeneration) return;
    const {
      at = 0,
      capture = false,
      paused = false,
      run = '',
      preload = false,
    } = options;
    activeCaptureFinalState = capture;
    activeFilmRun = run;
    demoClock = Math.max(0, Number(at) || 0);
    demoClockStamp = performance.now();
    demoPaused = paused;
    window.__HECTRA_FILM_DEMO_READY__ = false;
    document.documentElement.dataset.filmDemoReady = 'false';

    document.body.dataset.filmDemo = mode;
    document.body.classList.remove('theme-light');
    HectraRenderer.dismissEditOnboarding();

    HectraState.init();
    HectraState.sessionId = 'sess_1784439000000';
    HectraState.sessionTitle = mode === 'workflow'
      ? 'Gradient Descent — Working Notes'
      : 'Gradient descent notes';
    HectraState.sessionCreatedAt = FIXED_TIME.getTime();

    chatContainer.replaceChildren();
    document.getElementById('global-version-bar')?.classList.remove('visible');
    exitEditMode();
    setInput('');
    WORKFLOW_CLICK_CUES.forEach(cue => {
      delete cue.x;
      delete cue.y;
    });

    if (mode === 'workflow') {
      if (preload) {
        setStatus('ready');
        persistDemoState();
        settleViewport(generation);
        return;
      }
      await runWorkflow(generation);
      return;
    }

    const userMessage = HectraState.addUserMessage(INITIAL_PROMPT);
    userMessage.timestamp = FIXED_TIME;
    HectraRenderer.appendUserBubble(chatContainer, userMessage, { scroll: false });

    const initialSections = cloneSections(INITIAL_SECTIONS);
    const rawDocument = initialSections
      .map(section => `## ${section.title} [#${section.id}]\n${section.content}`)
      .join('\n\n');
    const assistantMessage = HectraState.addAIMessage(rawDocument, initialSections, []);
    assistantMessage.timestamp = FIXED_TIME;

    HectraRenderer.createAIMessageBlock(chatContainer, assistantMessage.msgIndex);
    await HectraRenderer.renderAIContent(
      assistantMessage.msgIndex,
      HectraState.getDocumentSectionsArray(),
      initialSections.map(section => section.id)
    );
    if (generation !== demoGeneration) return;
    HectraRenderer.setEditButton(
      assistantMessage.msgIndex,
      true,
      () => enterEditMode(assistantMessage.msgIndex)
    );

    if (preload || mode === 'state') {
      setStatus('ready');
      persistDemoState();
      settleViewport(generation);
      return;
    }

    if (mode === 'edit') {
      if (!await waitForStage(650, generation)) return;
      enterEditMode(assistantMessage.msgIndex);
      setInput(EDIT_INSTRUCTION);
      setStatus('thinking');
      chatScroll.scrollTop = 0;
      if (!await waitForStage(2700, generation)) return;
    } else {
      if (!await waitForStage(850, generation)) return;
    }

    const editResult = HectraState.applyEdit(
      [{ ...UPDATED_STEP }],
      [],
      ['Updated only point 2: added an intuitive hill-and-slope example.']
    );
    const previousSnapshot = HectraState.getPreviousSnapshot(assistantMessage.msgIndex);

    if (mode === 'edit') {
      HectraState.acceptVersion(assistantMessage.msgIndex);
      await HectraRenderer.renderAIContent(
        assistantMessage.msgIndex,
        HectraState.getDocumentSectionsArray(),
        ['step-2'],
        [],
        {}
      );
      if (generation !== demoGeneration) return;
      HectraRenderer.setChangelogs(
        assistantMessage.msgIndex,
        editResult.updatedMsg.changelogs
      );
      HectraRenderer.setEditButton(
        assistantMessage.msgIndex,
        true,
        () => enterEditMode(assistantMessage.msgIndex)
      );
      enterEditMode(assistantMessage.msgIndex);
      setInput('');
    } else {
      await HectraRenderer.renderAIContent(
        assistantMessage.msgIndex,
        HectraState.getDocumentSectionsArray(),
        editResult.updatedIds,
        editResult.deletedIds,
        {
          oldSnapshot: previousSnapshot,
          showDiff: true,
        }
      );
      if (generation !== demoGeneration) return;
      HectraRenderer.setChangelogs(
        assistantMessage.msgIndex,
        editResult.updatedMsg.changelogs
      );
      HectraRenderer.setEditButton(
        assistantMessage.msgIndex,
        true,
        () => enterEditMode(assistantMessage.msgIndex)
      );
      exitEditMode();
    }

    setStatus('ready');
    persistDemoState();
    setTimeout(() => settleViewport(generation), 180);
  }

  function reportDemoError(error) {
    console.error('[Hectra film demo] Failed to build deterministic state:', error);
    window.__HECTRA_FILM_DEMO_ERROR__ = String(error?.stack || error);
    window.parent?.postMessage({
      type: 'hectra-film-demo-error',
      mode,
      run: activeFilmRun,
    }, '*');
  }

  function scheduleBuild(options) {
    const generation = ++demoGeneration;
    buildQueue = buildQueue
      .catch(() => undefined)
      .then(() => buildDemo(options, generation))
      .catch(reportDemoError);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    if (event.data?.type === 'hectra-film-demo-pause') {
      setDemoPaused(true);
      return;
    }
    if (event.data?.type === 'hectra-film-demo-play') {
      setDemoPaused(false);
      return;
    }
    if (event.data?.type === 'hectra-film-demo-start') {
      scheduleBuild({
        at: Math.max(0, Number(event.data.at) || 0),
        capture: Boolean(event.data.capture),
        paused: Boolean(event.data.paused),
        run: String(event.data.run || ''),
        preload: false,
      });
    }
  });

  scheduleBuild({
    at: initialFilmAt,
    capture: initialCaptureFinalState,
    paused: false,
    run: initialFilmRun,
    preload: initialPreloadOnly,
  });

  ensureWorkflowMotion();

  window.addEventListener('pagehide', () => {
    if (workflowMotionRaf) cancelAnimationFrame(workflowMotionRaf);
  }, { once: true });
})();
