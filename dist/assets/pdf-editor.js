import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

(() => {
  'use strict';

  const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
  const $ = (selector, root = document) => root.querySelector(selector);
  const stage = $('#document-stage');
  const emptyState = $('#stage-empty');
  const pageElement = $('#pdf-page');
  const canvas = $('#pdf-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const layer = $('#annotation-layer');
  const textSelectionLayer = $('#text-selection-layer');
  const formFieldLayer = $('#form-field-layer');
  const status = $('#editor-status');
  const filePicker = $('#pdf-file');
  const mergePicker = $('#merge-pdf-file');
  const inputImage = $('#image-file');
  const historyLimit = 35;

  let pdfDocument = null;
  let loadingTask = null;
  let originalBytes = null;
  let originalName = '';
  let pages = [];
  let currentPage = 1;
  let zoom = 1;
  let selectedId = null;
  let history = [];
  let historyIndex = -1;
  let exportedHistoryIndex = 0;
  let dragState = null;
  let inspectorEditing = false;
  let inspectorController = null;
  let signatureDbPromise = null;
  let signaturePointerDown = false;
  let pageRenderTask = null;
  let pageRenderSequence = 0;
  let textEditMode = false;
  let pendingReplacement = null;
  let pendingReplacementInitial = null;
  let inlineTextEditor = null;
  let selectableTextRegions = [];
  let formValues = {};
  let markupMode = false;
  let drawingState = null;
  let selectedPagesForExtraction = new Set();
  let textTargetSequence = 0;
  let thumbnailObserver = null;
  let thumbnailRenderSequence = 0;
  let tesseractLoadPromise = null;
  let activeOcrWorker = null;
  let ocrCancelled = false;
  let ocrRunning = false;
  let ocrCurrentPage = 0;

  const uid = () => globalThis.crypto?.randomUUID?.() || `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const safeFilename = (value) => String(value || 'documento').replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'documento';
  const deepCopy = (value) => JSON.parse(JSON.stringify(value));
  const activePage = () => pages[currentPage - 1] || null;
  const activeAnnotations = () => activePage()?.annotations || [];
  const selectedAnnotation = () => activeAnnotations().find((item) => item.id === selectedId) || null;

  function showStatus(message, type = 'info') {
    SuiteUtils.setStatus(status, message, type);
  }

  function setDocumentControls(enabled) {
    ['#close-pdf', '#add-pdf', '#insert-blank-page', '#extract-pages', '#undo', '#redo', '#zoom', '#zoom-out', '#zoom-in', '#fit-page', '#download-pdf', '#add-text', '#edit-existing-text', '#recognize-ocr', '#add-signature', '#add-image', '#draw-signature', '#add-stamp', '#markup-toggle'].forEach((selector) => {
      $(selector).disabled = !enabled;
    });
    $('#ocr-start').disabled = !enabled;
  }

  function updateHistoryButtons() {
    $('#undo').disabled = historyIndex <= 0;
    $('#redo').disabled = historyIndex >= history.length - 1;
  }

  function snapshot() {
    return { pages: deepCopy(pages), formValues: deepCopy(formValues) };
  }

  function recordHistory() {
    if (!pages.length) return;
    const current = snapshot();
    const encoded = JSON.stringify(current);
    if (historyIndex >= 0 && JSON.stringify(history[historyIndex]) === encoded) return;
    history = history.slice(0, historyIndex + 1);
    history.push(current);
    if (history.length > historyLimit) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }

  function restoreHistory(index) {
    if (index < 0 || index >= history.length) return;
    historyIndex = index;
    const state = history[index];
    pages = deepCopy(state.pages || []);
    formValues = deepCopy(state.formValues || {});
    currentPage = Math.max(1, Math.min(currentPage, pages.length));
    selectedId = null;
    updateHistoryButtons();
    updatePageCount();
    renderThumbnails().then(renderCurrentPage);
  }

  async function openPdf(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      showStatus('Selecciona un archivo PDF.', 'error');
      return;
    }
    if (file.size > 120 * 1024 * 1024) {
      showStatus('El PDF supera el límite local de 120 MB. Prueba con una copia más pequeña.', 'error');
      return;
    }
    showStatus('Abriendo el documento en este navegador…');
    setDocumentControls(false);
    try {
      if (loadingTask) await loadingTask.destroy();
      const bytes = new Uint8Array(await file.arrayBuffer());
      // PDF.js may transfer its input buffer to the worker; retain an untouched
      // copy for the later export step.
      loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, useWasm: false });
      const documentProxy = await loadingTask.promise;
      if (documentProxy.numPages > 300) throw new Error('El documento tiene más de 300 páginas. Para proteger la memoria del navegador, abre una copia más corta.');
      pdfDocument = documentProxy;
      originalBytes = bytes;
      originalName = file.name;
      pages = Array.from({ length: pdfDocument.numPages }, (_, index) => ({ id: uid(), number: index + 1, sourceIndex: index, rotation: null, blank: false, annotations: [], width: 0, height: 0 }));
      formValues = {};
      currentPage = 1;
      selectedId = null;
      history = [];
      historyIndex = -1;
      exportedHistoryIndex = 0;
      stopTextEditMode();
      $('#file-name').textContent = file.name;
      $('#file-name').title = file.name;
      $('#page-count').textContent = `${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}`;
      emptyState.hidden = true;
      pageElement.hidden = false;
      setDocumentControls(true);
      recordHistory();
      await renderCurrentPage();
      await renderThumbnails();
      showStatus('PDF abierto localmente. El archivo original permanece sin cambios.');
    } catch (error) {
      pdfDocument = null;
      originalBytes = null;
      originalName = '';
      pages = [];
      currentPage = 1;
      layer.replaceChildren();
      pageElement.hidden = true;
      emptyState.hidden = false;
      setDocumentControls(false);
      const message = /password|encrypted/i.test(String(error?.message || error))
        ? 'Este PDF está protegido con contraseña. La Etapa 1 no admite documentos cifrados.'
        : `No se pudo abrir el PDF: ${error?.message || 'archivo dañado o formato no compatible'}`;
      showStatus(message, 'error');
    } finally {
      filePicker.value = '';
    }
  }

  async function renderCurrentPage() {
    if (!pdfDocument || !activePage()) return;
    const renderSequence = ++pageRenderSequence;
    if (pageRenderTask) { try { pageRenderTask.cancel(); } catch (_) {} pageRenderTask = null; }
    const pageNumber = currentPage;
    const pageInfo = pages[pageNumber - 1];
    const pdfPage = pageInfo.blank ? null : await pdfDocument.getPage(pageInfo.sourceIndex + 1);
    if (pdfPage && pageInfo.rotation == null) pageInfo.rotation = pdfPage.rotate || 0;
    const viewport = pdfPage
      ? pdfPage.getViewport({ scale: zoom, rotation: pageInfo.rotation })
      : { width: pageInfo.width * zoom, height: pageInfo.height * zoom };
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    if (!pdfPage) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const renderContext = { canvasContext: ctx, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] };
      pageRenderTask = pdfPage.render(renderContext);
      try { await pageRenderTask.promise; }
      catch (error) {
        if (error?.name === 'RenderingCancelledException') return;
        if (renderSequence === pageRenderSequence) showStatus(`No se pudo renderizar esta página: ${error?.message || 'error de lectura'}`, 'error');
        return;
      } finally { if (renderSequence === pageRenderSequence) pageRenderTask = null; }
    }
    if (currentPage !== pageNumber || renderSequence !== pageRenderSequence) return;
    $('#current-page-label').textContent = `Página ${currentPage} / ${pages.length}`;
    renderAnnotations();
    document.querySelectorAll('.page-card').forEach((card) => card.classList.toggle('is-current', card.dataset.pageId === pageInfo.id));
    await renderFormFields(pageInfo, pdfPage, viewport);
    if (textEditMode) await renderTextTargets();
  }

  async function renderFormFields(pageInfo, pdfPage, viewport) {
    formFieldLayer.replaceChildren();
    formFieldLayer.style.width = `${pageInfo.width * zoom}px`;
    formFieldLayer.style.height = `${pageInfo.height * zoom}px`;
    if (!pdfPage || pageInfo.blank) return;
    try {
      const annotations = await pdfPage.getAnnotations({ intent: 'display' });
      let incompatible = false;
      for (const annotation of annotations) {
        if (annotation.subtype !== 'Widget' && annotation.annotationType !== pdfjsLib.AnnotationType?.WIDGET) continue;
        const fieldName = annotation.fieldName;
        if (!fieldName) { incompatible = true; continue; }
        const value = Object.hasOwn(formValues, fieldName) ? formValues[fieldName] : annotation.fieldValue;
        if (!Object.hasOwn(formValues, fieldName)) formValues[fieldName] = value;
        const fieldType = annotation.fieldType;
        if (fieldType === 'Sig' || (fieldType === 'Btn' && (annotation.fieldFlags & 32768))) { incompatible = true; continue; }
        let control;
        if (fieldType === 'Tx') {
          control = annotation.multiLine ? document.createElement('textarea') : document.createElement('input');
          if (control.tagName === 'INPUT') control.type = 'text';
          control.value = String(value ?? '');
          control.addEventListener('input', () => { formValues[fieldName] = control.value; });
          control.addEventListener('change', () => recordHistory());
        } else if (fieldType === 'Btn') {
          const isRadio = Boolean(annotation.fieldFlags & 16);
          control = document.createElement('input'); control.type = isRadio ? 'radio' : 'checkbox';
          const buttonValue = annotation.buttonValue || annotation.exportValue || 'Yes';
          control.name = `pdf-form-${fieldName}`;
          control.value = buttonValue;
          control.checked = isRadio ? String(value ?? '') === String(buttonValue) : Boolean(value && value !== 'Off');
          control.addEventListener('change', () => { formValues[fieldName] = isRadio ? control.value : control.checked; recordHistory(); });
        } else if (fieldType === 'Ch') {
          control = document.createElement('select');
          for (const option of annotation.options || []) {
            const optionEl = document.createElement('option');
            optionEl.value = String(option.exportValue ?? option.value ?? option.displayValue ?? option);
            optionEl.textContent = String(option.displayValue ?? option.value ?? option);
            control.append(optionEl);
          }
          control.value = String(value ?? '');
          control.addEventListener('change', () => { formValues[fieldName] = control.value; recordHistory(); });
        } else { incompatible = true; continue; }
        control.className = 'pdf-form-control';
        control.setAttribute('aria-label', fieldName);
        control.title = fieldName;
        // PDF.js 6 exposes convertToViewportPoint (not Rectangle). Convert all
        // corners because rotation can swap the corner order; viewport already
        // includes zoom, so do not scale these coordinates a second time.
        const [x1, y1, x2, y2] = annotation.rect;
        const corners = [viewport.convertToViewportPoint(x1, y1), viewport.convertToViewportPoint(x1, y2), viewport.convertToViewportPoint(x2, y1), viewport.convertToViewportPoint(x2, y2)];
        const left = Math.min(...corners.map((point) => point[0]));
        const top = Math.min(...corners.map((point) => point[1]));
        const right = Math.max(...corners.map((point) => point[0]));
        const bottom = Math.max(...corners.map((point) => point[1]));
        control.style.left = `${left}px`; control.style.top = `${top}px`;
        control.style.width = `${Math.max(18, right - left)}px`;
        control.style.height = `${Math.max(18, bottom - top)}px`;
        formFieldLayer.append(control);
      }
      if (incompatible) showStatus('Este PDF contiene uno o más campos interactivos no compatibles (por ejemplo, firmas digitales o botones especiales). Los campos compatibles sí se pueden completar.', 'error');
    } catch (error) {
      showStatus(`No se pudieron leer los campos del formulario: ${error?.message || 'formato no compatible'}`, 'error');
    }
  }

  async function renderThumbnails() {
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    const renderSequence = ++thumbnailRenderSequence;
    const list = $('#page-list');
    list.replaceChildren();
    const fragment = document.createDocumentFragment();
    pages.forEach((pageInfo, index) => {
      pageInfo.number = index + 1;
      const card = document.createElement('div');
      card.className = `page-card${pageInfo.number === currentPage ? ' is-current' : ''}`;
      card.dataset.pageId = pageInfo.id;
      card.draggable = true;
      const thumb = document.createElement('canvas');
      thumb.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = `Página ${pageInfo.number}`;
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'page-thumb';
      selectButton.setAttribute('aria-label', `Ir a página ${pageInfo.number}`);
      selectButton.append(thumb, label);
      selectButton.addEventListener('click', () => goToPage(index + 1));
      const tools = document.createElement('div');
      tools.className = 'page-card-tools';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.title = `Seleccionar página ${pageInfo.number} para extraer`;
      check.setAttribute('aria-label', `Seleccionar página ${pageInfo.number} para extraer`);
      check.checked = selectedPagesForExtraction.has(pageInfo.id);
      check.addEventListener('change', () => check.checked ? selectedPagesForExtraction.add(pageInfo.id) : selectedPagesForExtraction.delete(pageInfo.id));
      tools.append(check,
        pageToolButton('↑', `Mover página ${pageInfo.number} arriba`, () => movePageById(pageInfo.id, -1)),
        pageToolButton('↓', `Mover página ${pageInfo.number} abajo`, () => movePageById(pageInfo.id, 1)),
        pageToolButton('↺', `Rotar página ${pageInfo.number} a la izquierda`, () => rotatePageById(pageInfo.id, -1)),
        pageToolButton('↻', `Rotar página ${pageInfo.number} a la derecha`, () => rotatePageById(pageInfo.id, 1)),
        pageToolButton('⧉', `Duplicar página ${pageInfo.number}`, () => duplicatePageById(pageInfo.id)),
        pageToolButton('×', `Eliminar página ${pageInfo.number}`, () => deletePageById(pageInfo.id)));
      card.append(selectButton, tools);
      card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', pageInfo.id); event.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
      card.addEventListener('drop', (event) => { event.preventDefault(); reorderPageIds(event.dataTransfer.getData('text/plain'), pageInfo.id); });
      fragment.append(card);
    });
    list.append(fragment);
    const thumbnailJobs = [];
    for (const pageInfo of pages) {
      const thumb = $(`.page-card[data-page-id="${pageInfo.id}"] canvas`);
      let pdfPage = null;
      if (!pageInfo.blank) {
        pdfPage = await pdfDocument.getPage(pageInfo.sourceIndex + 1);
        if (pageInfo.rotation == null) pageInfo.rotation = pdfPage.rotate || 0;
        const base = pdfPage.getViewport({ scale: 1, rotation: pageInfo.rotation });
        pageInfo.width = base.width;
        pageInfo.height = base.height;
      }
      const scale = Math.min(116 / pageInfo.width, 142 / pageInfo.height);
      const thumbWidth = pageInfo.width * scale;
      const thumbHeight = pageInfo.height * scale;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      thumb.width = Math.ceil(thumbWidth * ratio);
      thumb.height = Math.ceil(thumbHeight * ratio);
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.height = `${thumbHeight}px`;
      thumbnailJobs.push({ thumb, pageInfo, sourceIndex: pageInfo.blank ? null : pageInfo.sourceIndex, scale, ratio });
    }
    const renderThumbnail = async (job) => {
      if (renderSequence !== thumbnailRenderSequence || job.thumb.dataset.rendered === 'true') return;
      job.thumb.dataset.rendered = 'true';
      const tctx = job.thumb.getContext('2d', { alpha: false });
      try {
        if (job.sourceIndex !== null && pdfDocument) {
          const pdfPage = await pdfDocument.getPage(job.sourceIndex + 1);
          const viewport = pdfPage.getViewport({ scale: job.scale, rotation: job.pageInfo.rotation });
          await pdfPage.render({ canvasContext: tctx, viewport, transform: job.ratio === 1 ? null : [job.ratio, 0, 0, job.ratio, 0, 0] }).promise;
        } else { tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, job.thumb.width, job.thumb.height); }
      } catch (error) {
        job.thumb.dataset.rendered = 'false';
        if (renderSequence === thumbnailRenderSequence) showStatus(`No se pudo generar una miniatura: ${error?.message || 'error de renderizado'}`, 'error');
      }
    };
    if ('IntersectionObserver' in window) {
      thumbnailObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          thumbnailObserver?.unobserve(entry.target);
          const job = thumbnailJobs.find((candidate) => candidate.thumb === entry.target);
          if (job) renderThumbnail(job);
        });
      }, { root: list, rootMargin: '120px 0px' });
      thumbnailJobs.forEach((job) => thumbnailObserver.observe(job.thumb));
    } else {
      for (const job of thumbnailJobs) await renderThumbnail(job);
    }
    updatePageCount();
  }

  function pageToolButton(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => { event.stopPropagation(); action(); });
    return button;
  }

  function updatePageCount() {
    pages.forEach((page, index) => { page.number = index + 1; });
    $('#page-count').textContent = `${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}`;
    $('#current-page-label').textContent = pages.length ? `Página ${currentPage} / ${pages.length}` : '';
    const enabled = Boolean(pdfDocument && pages.length);
    ['#add-pdf', '#insert-blank-page', '#extract-pages'].forEach((selector) => { $(selector).disabled = !enabled; });
  }

  function pageIndexById(id) { return pages.findIndex((page) => page.id === id); }

  async function finishPageMutation(keepId = activePage()?.id) {
    currentPage = Math.max(1, pageIndexById(keepId) + 1);
    selectedId = null;
    selectedPagesForExtraction = new Set([...selectedPagesForExtraction].filter((id) => pageIndexById(id) >= 0));
    recordHistory();
    await renderThumbnails();
    await renderCurrentPage();
  }

  async function movePageById(id, delta) {
    const from = pageIndexById(id), to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const [page] = pages.splice(from, 1); pages.splice(to, 0, page);
    await finishPageMutation(id);
  }

  async function reorderPageIds(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const from = pageIndexById(fromId), to = pageIndexById(toId);
    if (from < 0 || to < 0) return;
    const [page] = pages.splice(from, 1); pages.splice(to, 0, page);
    await finishPageMutation(page.id);
  }

  async function rotatePageById(id, direction) {
    const index = pageIndexById(id);
    if (index < 0) return;
    const page = pages[index];
    if (page.rotation == null && !page.blank) page.rotation = (await pdfDocument.getPage(page.sourceIndex + 1)).rotate || 0;
    const oldWidth = page.width, oldHeight = page.height;
    page.rotation = (((page.rotation || 0) + (direction > 0 ? 90 : 270)) % 360);
    page.width = oldHeight; page.height = oldWidth;
    for (const item of page.annotations) {
      const x = item.x, y = item.y, width = item.width, height = item.height;
      if (direction > 0) { item.x = oldHeight - y - height; item.y = x; }
      else { item.x = y; item.y = oldWidth - x - width; }
      item.width = height; item.height = width;
      item.rotation = ((Number(item.rotation) || 0) + (direction > 0 ? 90 : 270)) % 360;
    }
    await finishPageMutation(page.id);
  }

  async function duplicatePageById(id) {
    const index = pageIndexById(id);
    if (index < 0 || pages.length >= 300) { showStatus('No se pueden superar las 300 páginas.', 'error'); return; }
    const copy = deepCopy(pages[index]);
    copy.id = uid();
    copy.annotations.forEach((item) => { item.id = uid(); });
    pages.splice(index + 1, 0, copy);
    await finishPageMutation(copy.id);
  }

  async function deletePageById(id) {
    const index = pageIndexById(id);
    if (index < 0) return;
    if (pages.length < 2) { showStatus('El documento debe conservar al menos una página. Agrega otra antes de eliminar esta.', 'error'); return; }
    const pageNumber = index + 1;
    if (!window.confirm(`¿Eliminar la página ${pageNumber}? Esta acción se puede deshacer.`)) return;
    const currentId = activePage()?.id;
    pages.splice(index, 1);
    const keepId = currentId === id ? pages[Math.min(index, pages.length - 1)].id : currentId;
    await finishPageMutation(keepId);
  }

  async function insertBlankPage() {
    if (!pages.length || pages.length >= 300) return;
    const current = activePage();
    const blank = { id: uid(), sourceIndex: null, rotation: 0, blank: true, width: current?.width || 595, height: current?.height || 842, annotations: [] };
    pages.splice(currentPage, 0, blank);
    await finishPageMutation(blank.id);
  }

  async function mergePdf(file) {
    if (!file) return;
    if (file.size > 120 * 1024 * 1024 || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) { showStatus('Selecciona un PDF de hasta 120 MB.', 'error'); mergePicker.value = ''; return; }
    try {
      showStatus('Uniendo el PDF localmente…');
      const current = await PDFDocument.load(originalBytes, { updateMetadata: false });
      const extraBytes = new Uint8Array(await file.arrayBuffer());
      const extra = await PDFDocument.load(extraBytes, { updateMetadata: false });
      if (current.getPageCount() + extra.getPageCount() > 300) throw new Error('La unión superaría el límite de 300 páginas.');
      const start = current.getPageCount();
      const copied = await current.copyPages(extra, extra.getPageIndices());
      copied.forEach((page) => current.addPage(page));
      originalBytes = await current.save({ useObjectStreams: true });
      if (loadingTask) await loadingTask.destroy();
      loadingTask = pdfjsLib.getDocument({ data: originalBytes.slice(), isEvalSupported: false, useWasm: false });
      pdfDocument = await loadingTask.promise;
      for (let index = 0; index < copied.length; index += 1) {
        const sourceIndex = start + index;
        const rendered = await pdfDocument.getPage(sourceIndex + 1);
        const viewport = rendered.getViewport({ scale: 1 });
        pages.push({ id: uid(), number: pages.length + 1, sourceIndex, rotation: rendered.rotate || 0, blank: false, width: viewport.width, height: viewport.height, annotations: [] });
      }
      recordHistory();
      updatePageCount();
      await renderThumbnails();
      await renderCurrentPage();
      showStatus(`${copied.length} página${copied.length === 1 ? '' : 's'} agregada${copied.length === 1 ? '' : 's'}. Los archivos originales no se modificaron.`, 'success');
    } catch (error) { showStatus(`No se pudo unir el PDF: ${error?.message || 'formato no compatible'}`, 'error'); }
    finally { mergePicker.value = ''; }
  }

  function openExtractDialog() {
    const selected = pages.filter((page) => selectedPagesForExtraction.has(page.id)).map((page) => page.number);
    $('#extract-range').value = selected.length ? selected.join(', ') : '';
    $('#extract-dialog').showModal();
  }

  function parsePageRange(value) {
    const indexes = [];
    for (const piece of value.split(',').map((part) => part.trim()).filter(Boolean)) {
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(piece);
      if (!match) throw new Error(`Rango inválido: ${piece}`);
      const start = Number(match[1]), end = Number(match[2] || match[1]);
      if (start < 1 || end > pages.length || end < start) throw new Error(`El rango ${piece} no existe en este documento.`);
      for (let number = start; number <= end; number += 1) if (!indexes.includes(number - 1)) indexes.push(number - 1);
    }
    if (!indexes.length) throw new Error('Selecciona páginas o escribe un rango.');
    return indexes.map((index) => pages[index]);
  }

  async function goToPage(number) {
    if (!pdfDocument || number < 1 || number > pages.length) return;
    if (pendingReplacement) applyTextReplacement();
    currentPage = number;
    selectedId = null;
    await renderCurrentPage();
    $('#inspector-empty').hidden = false;
    $('#inspector-fields').hidden = true;
    if (window.matchMedia('(max-width: 760px)').matches) pageElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function fitPage() {
    const page = activePage();
    if (!page || !pdfDocument) return;
    const applyFit = (width, height) => {
      const horizontalSpace = Math.max(260, stage.clientWidth - 56);
      const verticalSpace = Math.max(300, stage.clientHeight - 56);
      zoom = Math.min(horizontalSpace / width, verticalSpace / height, 1.6);
      zoom = Math.max(.35, Math.min(2, zoom));
      $('#zoom').value = String(Math.round(zoom * 100));
      $('#zoom-value').value = `${Math.round(zoom * 100)}%`;
      $('#zoom-value').textContent = `${Math.round(zoom * 100)}%`;
      renderCurrentPage();
    };
    if (page.blank) applyFit(page.width, page.height);
    else pdfDocument.getPage(page.sourceIndex + 1).then((pdfPage) => { const viewport = pdfPage.getViewport({ scale: 1, rotation: page.rotation ?? pdfPage.rotate }); applyFit(viewport.width, viewport.height); });
  }

  function addAnnotation(annotation) {
    const page = activePage();
    if (!page) return;
    annotation.id ||= uid();
    page.annotations.push(annotation);
    selectedId = annotation.id;
    recordHistory();
    renderAnnotations();
  }

  function toggleMarkupMode(force = !markupMode) {
    markupMode = Boolean(force && pdfDocument);
    $('#markup-tools').hidden = !markupMode;
    $('#markup-toggle').classList.toggle('is-active', markupMode);
    $('#markup-toggle').setAttribute('aria-pressed', String(markupMode));
    layer.classList.toggle('is-drawing', markupMode);
    if (markupMode) {
      if (textEditMode) toggleTextEditMode(false);
      showStatus('Anotación activa: arrastra sobre la página para dibujar.');
    }
  }

  function openStampDialog() {
    $('#stamp-dialog').showModal();
    $('#stamp-preset').focus();
  }

  function insertStamp() {
    const preset = $('#stamp-preset').value;
    const text = preset === 'custom' ? $('#stamp-custom-text').value.trim() : preset;
    if (!text) { showStatus('Escribe el texto del sello personalizado.', 'error'); return; }
    const fontSize = Math.max(8, Math.min(96, Number($('#stamp-size').value) || 24));
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `800 ${fontSize}px Arial`;
    const width = Math.min(activePage()?.width || 400, Math.max(110, measure.measureText(text.toUpperCase()).width + 32));
    const height = Math.max(36, fontSize * 1.8);
    const position = nextPosition(width, height);
    $('#stamp-dialog').close();
    addAnnotation({ id: uid(), type: 'stamp', text, family: 'Helvetica', fontSize, color: $('#stamp-color').value, strokeWidth: 2, bold: true, italic: false, align: 'center', ...position, width, height, rotation: 0, opacity: .8 });
  }

  function layerPoint(event) {
    const bounds = layer.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom };
  }

  function startMarkupDraw(event) {
    const point = layerPoint(event);
    drawingState = { pointerId: event.pointerId, pageId: activePage()?.id, type: $('#markup-type').value, color: $('#markup-color').value, strokeWidth: Math.max(1, Math.min(24, Number($('#markup-width').value) || 4)), fill: $('#markup-fill').checked, start: point, end: point, points: [point] };
    layer.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function markupAnnotationFromState(state) {
    const bounds = state.type === 'freehand' ? state.points : [state.start, state.end];
    const minX = Math.min(...bounds.map((point) => point.x)), minY = Math.min(...bounds.map((point) => point.y));
    const maxX = Math.max(...bounds.map((point) => point.x)), maxY = Math.max(...bounds.map((point) => point.y));
    const width = Math.max(2, maxX - minX), height = Math.max(2, maxY - minY);
    const points = state.type === 'freehand'
      ? state.points.map((point) => ({ x: (point.x - minX) / width, y: (point.y - minY) / height }))
      : [{ x: (state.start.x - minX) / width, y: (state.start.y - minY) / height }, { x: (state.end.x - minX) / width, y: (state.end.y - minY) / height }];
    return { id: uid(), type: state.type, color: state.color, strokeWidth: state.strokeWidth, fill: state.fill, x: minX, y: minY, width, height, points, rotation: 0, opacity: state.type === 'highlight' ? .36 : 1 };
  }

  function nextPosition(width, height) {
    const page = activePage();
    const index = page?.annotations.length || 0;
    return {
      x: Math.max(8, Math.min(42 + index * 18, (page?.width || width + 16) - width - 8)),
      y: Math.max(8, Math.min(48 + index * 82, (page?.height || height + 16) - height - 8)),
    };
  }

  function renderAnnotations(refreshInspector = true) {
    layer.replaceChildren();
    const annotations = activeAnnotations().slice();
    if (pendingReplacement && pendingReplacement.pageNumber === currentPage) annotations.push(pendingReplacement);
    if (drawingState?.pageId === activePage()?.id) annotations.push(markupAnnotationFromState(drawingState));
    for (const item of annotations) {
      const element = document.createElement('div');
      element.className = `annotation${item.type === 'replace-text' ? ' annotation--replacement' : ''}${item.id === selectedId ? ' is-selected' : ''}`;
      element.dataset.annotationId = item.id;
      element.style.left = `${item.x * zoom}px`;
      element.style.top = `${item.y * zoom}px`;
      element.style.width = `${item.width * zoom}px`;
      element.style.height = `${item.height * zoom}px`;
      element.style.opacity = String(item.opacity ?? 1);
      element.style.transform = `rotate(${item.rotation || 0}deg)`;
      if (['text', 'stamp', 'replace-text'].includes(item.type)) {
        const content = document.createElement('div');
        content.className = item.type === 'replace-text' ? 'replace-text-cover' : 'annotation-text';
        content.textContent = item.text;
        content.style.fontFamily = item.family;
        content.style.fontSize = `${item.fontSize * zoom}px`;
        content.style.fontWeight = item.bold ? '700' : '400';
        content.style.fontStyle = item.italic ? 'italic' : 'normal';
        content.style.color = item.color;
        content.style.textAlign = item.align;
        content.style.lineHeight = String(item.lineHeight || 1.2);
        if (item.type === 'replace-text') {
          content.style.backgroundColor = item.coverColor || '#ffffff';
          const coverPadding = Math.max(0, Number(item.coverPadding) || 0);
          if (coverPadding) content.style.boxShadow = `0 0 0 ${coverPadding * zoom}px ${item.coverColor || '#ffffff'}`;
        }
        if (item.type === 'stamp') { content.style.display = 'grid'; content.style.placeItems = 'center'; content.style.border = `${Math.max(1, (item.strokeWidth || 2) * zoom)}px solid ${item.color}`; content.style.fontWeight = '800'; content.style.letterSpacing = '.04em'; content.style.textTransform = 'uppercase'; }
        element.append(content);
      } else if (item.type === 'image') {
        const image = document.createElement('img');
        image.className = 'annotation-image';
        image.alt = item.isSignature ? 'Firma electrónica visible' : 'Imagen añadida al PDF';
        image.src = item.dataUrl;
        element.append(image);
      } else if (['highlight', 'line', 'arrow', 'rectangle', 'ellipse', 'freehand'].includes(item.type)) element.append(renderMarkupSvg(item));
      if (item.id === selectedId) {
        const handle = document.createElement('span');
        handle.className = 'resize-handle';
        handle.setAttribute('aria-label', 'Cambiar tamaño');
        element.append(handle);
      }
      layer.append(element);
    }
    syncInlineTextEditor();
    if (refreshInspector) updateInspector();
  }

  function renderMarkupSvg(item) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('annotation-svg');
    const width = Math.max(1, Number(item.width) || 1), height = Math.max(1, Number(item.height) || 1);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const stroke = item.color || '#d23f31';
    const shape = document.createElementNS(ns, item.type === 'ellipse' ? 'ellipse' : ['rectangle', 'highlight'].includes(item.type) ? 'rect' : 'path');
    shape.setAttribute('stroke', stroke);
    shape.setAttribute('stroke-width', String(Math.max(1, Number(item.strokeWidth) || 3)));
    // Opacity is applied once on the containing annotation, matching pdf-lib.
    shape.setAttribute('fill', item.fill || item.type === 'highlight' ? stroke : 'none');
    if (item.type === 'ellipse') { shape.setAttribute('cx', String(width / 2)); shape.setAttribute('cy', String(height / 2)); shape.setAttribute('rx', String(width / 2)); shape.setAttribute('ry', String(height / 2)); }
    else if (['rectangle', 'highlight'].includes(item.type)) { shape.setAttribute('x', '0'); shape.setAttribute('y', '0'); shape.setAttribute('width', String(width)); shape.setAttribute('height', String(height)); }
    else {
      const points = item.points?.length ? item.points : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      shape.setAttribute('d', points.map((point, index) => `${index ? 'L' : 'M'} ${point.x * width} ${point.y * height}`).join(' '));
      shape.setAttribute('fill', 'none'); shape.setAttribute('stroke-linecap', 'round'); shape.setAttribute('stroke-linejoin', 'round');
      if (item.type === 'arrow' && points.length >= 2) {
        const start = points[points.length - 2], end = points[points.length - 1];
        const x1 = start.x * width, y1 = start.y * height, x2 = end.x * width, y2 = end.y * height;
        const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.min(18, Math.max(8, (Number(item.strokeWidth) || 3) * 3));
        const leftX = x2 - head * Math.cos(angle - Math.PI / 6), leftY = y2 - head * Math.sin(angle - Math.PI / 6);
        const rightX = x2 - head * Math.cos(angle + Math.PI / 6), rightY = y2 - head * Math.sin(angle + Math.PI / 6);
        const headPath = document.createElementNS(ns, 'path'); headPath.setAttribute('d', `M ${leftX} ${leftY} L ${x2} ${y2} L ${rightX} ${rightY}`); headPath.setAttribute('stroke', stroke); headPath.setAttribute('stroke-width', String(item.strokeWidth || 3)); headPath.setAttribute('fill', 'none'); shape.dataset.arrowHead = `${leftX},${leftY} ${x2},${y2} ${rightX},${rightY}`;
      }
    }
    svg.append(shape);
    if (shape.dataset.arrowHead) { const head = document.createElementNS(ns, 'path'); head.setAttribute('d', `M ${shape.dataset.arrowHead.split(' ').join(' L ')}`); head.setAttribute('stroke', stroke); head.setAttribute('stroke-width', String(item.strokeWidth || 3)); head.setAttribute('fill', 'none'); svg.append(head); }
    return svg;
  }

  function syncInlineTextEditor() {
    if (!inlineTextEditor || !pendingReplacement || pendingReplacement.pageNumber !== currentPage) return;
    const item = pendingReplacement;
    inlineTextEditor.style.left = `${item.x * zoom}px`;
    inlineTextEditor.style.top = `${item.y * zoom}px`;
    inlineTextEditor.style.width = `${item.width * zoom}px`;
    inlineTextEditor.style.height = `${item.height * zoom}px`;
    inlineTextEditor.style.fontFamily = item.family === 'Times Roman' ? '"Times New Roman",serif' : item.family === 'Courier' ? '"Courier New",monospace' : 'Arial,sans-serif';
    inlineTextEditor.style.fontSize = `${item.fontSize * zoom}px`;
    inlineTextEditor.style.fontWeight = item.bold ? '700' : '400';
    inlineTextEditor.style.fontStyle = item.italic ? 'italic' : 'normal';
    inlineTextEditor.style.lineHeight = String(item.lineHeight || 1.2);
    inlineTextEditor.style.color = item.color;
    inlineTextEditor.style.textAlign = item.align;
    inlineTextEditor.style.backgroundColor = item.coverColor || '#fff';
    inlineTextEditor.style.transform = `rotate(${item.rotation || 0}deg)`;
  }

  function createInlineTextEditor(initialCaretIndex) {
    inlineTextEditor?.remove();
    const editor = document.createElement('textarea');
    editor.className = 'pdf-inline-text-editor';
    editor.setAttribute('aria-label', 'Editar texto directamente en la página del PDF');
    editor.spellcheck = false;
    editor.value = pendingReplacement.text;
    editor.addEventListener('input', () => {
      if (!pendingReplacement) return;
      pendingReplacement.text = editor.value;
      updatePendingReplacement(false);
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelPendingReplacement();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        editor.blur();
      }
    });
    pageElement.append(editor);
    inlineTextEditor = editor;
    syncInlineTextEditor();
    requestAnimationFrame(() => {
      if (inlineTextEditor !== editor) return;
      editor.focus();
      editor.scrollLeft = 0;
      editor.scrollTop = 0;
      const caret = Math.max(0, Math.min(editor.value.length, Number.isInteger(initialCaretIndex) ? initialCaretIndex : editor.value.length));
      editor.setSelectionRange(caret, caret);
    });
    editor.addEventListener('pointerup', () => {
      if (!pendingReplacement) return;
      pendingReplacement.width = Math.max(8, editor.getBoundingClientRect().width / zoom);
      pendingReplacement.height = Math.max(6, editor.getBoundingClientRect().height / zoom);
      $('#replacement-width').value = String(Number(pendingReplacement.width.toFixed(1)));
      $('#replacement-height').value = String(Number(pendingReplacement.height.toFixed(1)));
    });
  }

  function updateInspector() {
    const item = selectedAnnotation();
    const empty = $('#inspector-empty');
    const fields = $('#inspector-fields');
    if (!item) {
      empty.hidden = false;
      fields.hidden = true;
      fields.replaceChildren();
      return;
    }
    empty.hidden = true;
    fields.hidden = false;
    if (!fields.childElementCount || fields.dataset.type !== item.type) {
      fields.dataset.type = item.type;
      inspectorController?.abort();
      inspectorController = new AbortController();
      const isText = ['text', 'stamp'].includes(item.type);
      const isMarkup = ['highlight', 'line', 'arrow', 'rectangle', 'ellipse', 'freehand'].includes(item.type);
      fields.innerHTML = `
        ${isText ? `<div class="field"><label for="element-text">Texto</label><textarea id="element-text" maxlength="3000"></textarea></div>
        <div class="field"><label for="element-family">Tipografía PDF</label><select id="element-family"><option value="Helvetica">Helvetica</option><option value="Times Roman">Times Roman</option><option value="Courier">Courier</option></select></div>
        <div class="field-row"><div class="field"><label for="element-size">Tamaño (pt)</label><input id="element-size" type="number" min="6" max="96" step="1"></div><div class="field"><label for="element-color">Color</label><input id="element-color" type="color"></div></div>
        <div class="field-row"><div class="field"><label for="element-align">Alineación</label><select id="element-align"><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></div><div class="field"><label for="element-rotation">Rotación</label><input id="element-rotation" type="number" min="-180" max="180" step="1"></div></div>
        <div class="field-row"><label class="check-pill"><input id="element-bold" type="checkbox">Negrita</label><label class="check-pill"><input id="element-italic" type="checkbox">Cursiva</label></div>` : `<div class="field"><label for="element-rotation">Rotación</label><input id="element-rotation" type="number" min="-180" max="180" step="1"></div>${isMarkup ? `<div class="field-row"><div class="field"><label for="element-color">Color</label><input id="element-color" type="color"></div><div class="field"><label for="element-stroke-width">Grosor</label><input id="element-stroke-width" type="number" min="1" max="24"></div></div><label class="check-pill"><input id="element-fill" type="checkbox">Relleno</label>` : ''}`}
        <div class="field"><label for="element-opacity">Opacidad</label><input id="element-opacity" type="range" min="10" max="100" value="100"></div>
        <div class="field-row"><div class="field"><label for="element-width">Ancho (pt)</label><input id="element-width" type="number" min="18" step="1"></div><div class="field"><label for="element-height">Alto (pt)</label><input id="element-height" type="number" min="18" step="1" ${item.type === 'image' ? 'readonly aria-label="Alto, proporción bloqueada"' : ''}></div></div>
        ${item.type === 'image' && item.isSignature ? `<div class="field"><label for="signature-save-name">Guardar firma reutilizable</label><input id="signature-save-name" maxlength="60" placeholder="Nombre de la firma"></div><button class="btn btn--secondary" id="save-selected-signature" type="button">Guardar firma</button>` : ''}
        <div class="button-row"><button class="btn btn--accent" id="delete-element" type="button">Eliminar elemento</button></div>`;
      bindInspector(fields, item.type, inspectorController.signal);
    }
    if (['text', 'stamp'].includes(item.type)) {
      $('#element-text', fields).value = item.text;
      $('#element-family', fields).value = item.family;
      $('#element-size', fields).value = String(item.fontSize);
      $('#element-color', fields).value = item.color;
      $('#element-align', fields).value = item.align;
      $('#element-bold', fields).checked = item.bold;
      $('#element-italic', fields).checked = item.italic;
    }
    if (['highlight', 'line', 'arrow', 'rectangle', 'ellipse', 'freehand'].includes(item.type)) {
      $('#element-color', fields).value = item.color || '#d23f31';
      $('#element-stroke-width', fields).value = String(item.strokeWidth || 3);
      $('#element-fill', fields).checked = Boolean(item.fill);
    }
    $('#element-rotation', fields).value = String(item.rotation || 0);
    $('#element-opacity', fields).value = String(Math.round((item.opacity ?? 1) * 100));
    $('#element-width', fields).value = String(Math.round(item.width));
    $('#element-height', fields).value = String(Math.round(item.height));
  }

  function bindInspector(fields, type, signal) {
    const update = () => {
      const item = selectedAnnotation();
      if (!item) return;
      if (!inspectorEditing) { recordHistory(); inspectorEditing = true; }
      if (['text', 'stamp'].includes(type)) {
        item.text = $('#element-text', fields).value;
        item.family = $('#element-family', fields).value;
        item.fontSize = Math.max(6, Math.min(96, Number($('#element-size', fields).value) || 12));
        item.color = $('#element-color', fields).value;
        item.align = $('#element-align', fields).value;
        item.bold = $('#element-bold', fields).checked;
        item.italic = $('#element-italic', fields).checked;
      }
      if (['highlight', 'line', 'arrow', 'rectangle', 'ellipse', 'freehand'].includes(type)) {
        item.color = $('#element-color', fields).value;
        item.strokeWidth = Math.max(1, Math.min(24, Number($('#element-stroke-width', fields).value) || 3));
        item.fill = $('#element-fill', fields).checked;
      }
      item.rotation = Math.max(-180, Math.min(180, Number($('#element-rotation', fields).value) || 0));
      item.opacity = Math.max(.1, Math.min(1, Number($('#element-opacity', fields).value) / 100));
      item.width = Math.max(18, Number($('#element-width', fields).value) || item.width);
      if (type === 'image') {
        item.aspectRatio ||= item.width / Math.max(1, item.height);
        item.height = item.width / item.aspectRatio;
        $('#element-height', fields).value = String(Math.round(item.height));
      } else if (type === 'image') item.height = Math.max(18, Number($('#element-height', fields).value) || item.height);
      else item.height = Math.max(6, Number($('#element-height', fields).value) || item.height);
      renderAnnotations(false);
    };
    const commit = () => {
      if (inspectorEditing) recordHistory();
      inspectorEditing = false;
    };
    fields.addEventListener('input', update, { signal });
    fields.addEventListener('change', commit, { signal });
    fields.addEventListener('focusout', commit, { signal });
    $('#delete-element', fields).addEventListener('click', () => {
      const item = selectedAnnotation(); if (!item) return;
      pages[currentPage - 1].annotations = activeAnnotations().filter((annotation) => annotation.id !== item.id);
      selectedId = null; recordHistory(); renderAnnotations();
    });
    $('#save-selected-signature', fields)?.addEventListener('click', async () => {
      const item = selectedAnnotation();
      const name = $('#signature-save-name', fields).value.trim();
      if (!item?.isSignature || !name) { showStatus('Escribe un nombre para guardar esta firma.', 'error'); return; }
      try { await saveSignature(name, item.dataUrl); await renderSignatureLibrary(); showStatus('Firma guardada solo en este navegador.', 'success'); }
      catch (_) { showStatus('No se pudo guardar en IndexedDB. La firma insertada en el documento sigue disponible.', 'error'); }
    });
  }

  function createText() {
    if (!activePage()) return;
    const width = 220, height = 58, position = nextPosition(width, height);
    addAnnotation({ id: uid(), type: 'text', text: 'Escribe aquí', family: 'Helvetica', fontSize: 18, color: '#132f52', align: 'left', bold: false, italic: false, ...position, width, height, rotation: 0, opacity: 1 });
    const textArea = $('#element-text');
    textArea?.focus(); textArea?.select();
  }

  function inferTextFamily(style, fontName) {
    const signature = `${style?.fontFamily || ''} ${fontName || ''}`.toLowerCase();
    if (/mono|courier/.test(signature)) return 'Courier';
    if (/serif|times|georgia/.test(signature) && !/sans/.test(signature)) return 'Times Roman';
    return 'Helvetica';
  }

  function inferTextColor(rect) {
    try {
      const ratio = canvas.width / Math.max(1, canvas.clientWidth);
      const left = Math.max(0, Math.floor(rect.x * zoom * ratio));
      const top = Math.max(0, Math.floor(rect.y * zoom * ratio));
      const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(rect.width * zoom * ratio)));
      const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(rect.height * zoom * ratio)));
      const pixels = ctx.getImageData(left, top, width, height).data;
      const colors = new Map();
      for (let index = 0; index < pixels.length; index += 16) {
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2], alpha = pixels[index + 3];
        if (alpha < 100 || (r > 242 && g > 242 && b > 242)) continue;
        const key = [r, g, b].map((channel) => Math.round(channel / 24) * 24).join(',');
        colors.set(key, (colors.get(key) || 0) + 1);
      }
      const best = [...colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!best) return '#132f52';
      return `#${best.split(',').map((value) => Math.max(0, Math.min(255, Number(value))).toString(16).padStart(2, '0')).join('')}`;
    } catch (_) { return '#132f52'; }
  }

  async function renderTextTargets() {
    const sequence = ++textTargetSequence;
    textSelectionLayer.replaceChildren();
    if (!textEditMode || !pdfDocument || pendingReplacement) return;
    try {
      const pageInfo = activePage();
      if (!pageInfo || pageInfo.blank) { $('#text-edit-prompt').textContent = 'Esta página está en blanco y no contiene texto seleccionable.'; return; }
      const pdfPage = await pdfDocument.getPage(pageInfo.sourceIndex + 1);
      const content = await pdfPage.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      if (sequence !== textTargetSequence || !textEditMode) return;
      const viewport = pdfPage.getViewport({ scale: 1, rotation: pageInfo.rotation ?? pdfPage.rotate });
      const fragment = document.createDocumentFragment();
      const fragments = [];
      for (const item of content.items) {
        if (!item.str?.trim() || !Array.isArray(item.transform)) continue;
        const style = content.styles?.[item.fontName] || {};
        let fontMeta = null;
        try { fontMeta = pdfPage.commonObjs.get(item.fontName); } catch (_) { /* PDF.js may not expose metadata for embedded fonts. */ }
        const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const angle = Math.atan2(transform[1], transform[0]);
        const fontSize = Math.max(4, Math.hypot(transform[2], transform[3]));
        const ascent = (style.ascent ?? .8) * fontSize;
        const descent = Math.abs(style.descent ?? -.2) * fontSize;
        const rect = {
          x: transform[4],
          y: transform[5] - ascent,
          width: Math.max(fontSize * .4, Math.abs(item.width || fontSize)),
          height: Math.max(fontSize, ascent + descent),
          fontSize,
          rotation: angle * 180 / Math.PI,
        };
        fragments.push({ text: item.str, rect, style, fontMeta, fontName: item.fontName });
      }
      selectableTextRegions = makeEditableTextBlocks(fragments);
      if (!selectableTextRegions.length && Array.isArray(pageInfo.ocrBlocks)) {
        selectableTextRegions = pageInfo.ocrBlocks.filter((block) => block.level === $('#ocr-level').value).map((block) => ({
          ...block,
          family: block.family || 'Helvetica',
          fontSize: block.fontSize || Math.max(7, block.height * .78),
          bold: Boolean(block.bold), italic: Boolean(block.italic), align: block.align || 'left',
          lineHeight: block.lineHeight || 1.12, rotation: block.rotation || 0,
        }));
      }
      let detected = 0;
      for (const block of selectableTextRegions) {
        const target = document.createElement('button');
        target.type = 'button';
        target.className = 'text-target';
        target.title = `Editar párrafo: ${block.text}`;
        target.setAttribute('aria-label', `Seleccionar texto: ${block.text}`);
        target.style.left = `${block.x * zoom}px`;
        target.style.top = `${block.y * zoom}px`;
        target.style.width = `${block.width * zoom}px`;
        target.style.height = `${block.height * zoom}px`;
        if (Math.abs(block.rotation) > .5) target.style.transform = `rotate(${block.rotation}deg)`;
        target.addEventListener('click', (event) => {
          const caretIndex = textCaretIndex(event, block, target);
          selectTextItem({
          pageNumber: currentPage,
          originalText: block.text,
          text: block.text,
          family: block.family,
          fontSize: block.fontSize,
          color: block.color || inferTextColor(block),
          coverColor: block.coverColor || '#ffffff',
          coverEstimateReliable: block.coverEstimateReliable !== false,
          isOcr: Boolean(block.isOcr),
          coverPadding: block.isOcr ? 1.5 : 0,
          bold: block.bold,
          italic: block.italic,
          align: block.align,
          lineHeight: block.lineHeight,
          x: block.x,
          y: block.y,
          width: block.width,
          sourceWidth: block.width,
          height: block.height,
          rotation: block.rotation,
          opacity: 1,
          }, caretIndex);
        });
        fragment.append(target);
        detected += 1;
      }
      textSelectionLayer.append(fragment);
      if (!detected) {
        $('#text-edit-prompt').textContent = 'No se encontró texto seleccionable en esta página. Si es un escaneo, puedes reconocerlo con la herramienta OCR.';
        showStatus('No se detectó texto seleccionable. Para una página escaneada, ejecuta Reconocer texto (OCR).', 'info');
      } else {
        $('#text-edit-prompt').textContent = `Haz clic en uno de los ${detected} bloques de texto resaltables de la página ${currentPage}.`;
      }
    } catch (error) {
      $('#text-edit-prompt').textContent = `No se pudo analizar el texto de esta página: ${error?.message || 'error de lectura'}`;
      showStatus(`No se pudo detectar el texto del PDF: ${error?.message || 'error de lectura'}`, 'error');
    }
  }

  function loadTesseract() {
    if (window.Tesseract?.createWorker) return Promise.resolve(window.Tesseract);
    if (tesseractLoadPromise) return tesseractLoadPromise;
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./vendor/tesseract/tesseract.min.js', import.meta.url).href;
      script.async = true;
      script.onload = () => window.Tesseract?.createWorker ? resolve(window.Tesseract) : reject(new Error('La biblioteca OCR local no se inicializó.'));
      script.onerror = () => reject(new Error('No se pudo cargar la biblioteca OCR local. Comprueba que la carpeta de recursos esté incluida en la publicación.'));
      document.head.append(script);
    }).catch((error) => { tesseractLoadPromise = null; throw error; });
    return tesseractLoadPromise;
  }

  function setOcrStatus(message, progress = null) {
    $('#ocr-status').textContent = message;
    const wrap = $('#ocr-progress-wrap');
    const bar = $('#ocr-progress');
    wrap.hidden = progress == null;
    if (progress != null) bar.value = Math.max(0, Math.min(1, progress));
  }

  async function cancelOcr() {
    if (!ocrRunning) return;
    ocrCancelled = true;
    const worker = activeOcrWorker;
    activeOcrWorker = null;
    if (worker) { try { await worker.terminate(); } catch (_) { /* Terminar también puede rechazar la tarea activa. */ } }
    $('#ocr-cancel').hidden = true;
    $('#ocr-start').disabled = !pdfDocument;
    setOcrStatus('Reconocimiento cancelado. Los resultados ya reconocidos se conservaron.', null);
  }

  function extractOcrLines(data) {
    const regions = [];
    for (const block of data?.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        const paragraphText = String(paragraph.text || '').trim();
        if (paragraphText && paragraph.bbox?.x1 > paragraph.bbox?.x0 && paragraph.bbox?.y1 > paragraph.bbox?.y0) regions.push({ level: 'paragraph', text: paragraphText, confidence: Number(paragraph.confidence) || 0, bbox: paragraph.bbox });
        for (const line of paragraph.lines || []) {
          const text = String(line.text || '').trim();
          const box = line.bbox;
          if (!text || !box || box.x1 <= box.x0 || box.y1 <= box.y0) continue;
          regions.push({ level: 'line', text, confidence: Number(line.confidence) || 0, bbox: box });
          for (const word of line.words || []) {
            const wordText = String(word.text || '').trim();
            const wordBox = word.bbox;
            if (wordText && wordBox && wordBox.x1 > wordBox.x0 && wordBox.y1 > wordBox.y0) regions.push({ level: 'word', text: wordText, confidence: Number(word.confidence) || 0, bbox: wordBox });
          }
        }
      }
    }
    return regions;
  }

  // Estimate a small opaque cover from pixels surrounding one OCR region.
  // This is a visual approximation only; textured/complex paper still needs review.
  function estimateOcrAppearance(canvasElement, bbox) {
    const fallback = { color: '#202020', coverColor: '#f3f3f3', bold: false, coverEstimateReliable: false };
    try {
      const context = canvasElement.getContext('2d', { willReadFrequently: true });
      if (!context) return fallback;
      const left = Math.max(0, Math.floor(bbox.x0));
      const top = Math.max(0, Math.floor(bbox.y0));
      const right = Math.min(canvasElement.width, Math.ceil(bbox.x1));
      const bottom = Math.min(canvasElement.height, Math.ceil(bbox.y1));
      const regionWidth = right - left, regionHeight = bottom - top;
      if (regionWidth < 1 || regionHeight < 1) return fallback;
      const pad = Math.max(2, Math.min(8, Math.round(regionHeight * .14)));
      const sampleLeft = Math.max(0, left - pad), sampleTop = Math.max(0, top - pad);
      const sampleRight = Math.min(canvasElement.width, right + pad), sampleBottom = Math.min(canvasElement.height, bottom + pad);
      const pixels = context.getImageData(sampleLeft, sampleTop, sampleRight - sampleLeft, sampleBottom - sampleTop);
      const background = [], foreground = [];
      const luminance = (r, g, b) => .2126 * r + .7152 * g + .0722 * b;
      const pointAt = (x, y) => {
        const offset = ((y - sampleTop) * pixels.width + (x - sampleLeft)) * 4;
        const r = pixels.data[offset], g = pixels.data[offset + 1], b = pixels.data[offset + 2];
        return { r, g, b, lum: luminance(r, g, b) };
      };
      // The outer ring excludes most glyph pixels, so it better estimates paper color.
      for (let y = sampleTop; y < sampleBottom; y += 1) {
        for (let x = sampleLeft; x < sampleRight; x += 1) {
          if (x >= left && x < right && y >= top && y < bottom) continue;
          background.push(pointAt(x, y));
        }
      }
      if (background.length < 8) return fallback;
      const median = (values) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const bgLum = median(background.map((pixel) => pixel.lum));
      const bg = {
        r: Math.round(median(background.map((pixel) => pixel.r))),
        g: Math.round(median(background.map((pixel) => pixel.g))),
        b: Math.round(median(background.map((pixel) => pixel.b))),
      };
      const deviations = background.map((pixel) => Math.abs(pixel.lum - bgLum));
      const bgMad = median(deviations);
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const pixel = pointAt(x, y);
          if (Math.abs(pixel.lum - bgLum) > Math.max(58, bgLum * .3)) foreground.push(pixel);
        }
      }
      const fg = foreground.length >= 4 ? {
        r: Math.round(median(foreground.map((pixel) => pixel.r))),
        g: Math.round(median(foreground.map((pixel) => pixel.g))),
        b: Math.round(median(foreground.map((pixel) => pixel.b))),
      } : { r: 32, g: 32, b: 32 };
      const hex = ({ r, g, b }) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      const inkRatio = foreground.length / (regionWidth * regionHeight);
      return {
        color: hex(fg),
        coverColor: hex(bg),
        // OCR does not expose font weight; ink coverage is only a rough visual hint.
        bold: inkRatio >= .17,
        coverEstimateReliable: bgMad <= 10,
      };
    } catch (_) {
      // Keep OCR usable on browsers that restrict canvas pixel inspection.
      return fallback;
    }
  }

  async function runOcr() {
    if (!pdfDocument || activeOcrWorker) return;
    let pageNumbers;
    try {
      const scope = $('#ocr-scope').value;
      pageNumbers = scope === 'all' ? pages.map((_, index) => index + 1)
        : scope === 'range' ? parsePageRange($('#ocr-range').value).map((page) => page.number)
          : [currentPage];
      if (!pageNumbers.length) throw new Error('Indica al menos una página válida.');
    } catch (error) { setOcrStatus(error.message || 'Revisa el rango de páginas.'); return; }

    const docAtStart = pdfDocument;
    const language = $('#ocr-language').value;
    let found = 0, foundLines = 0, skipped = 0, changesCommitted = false;
    ocrCancelled = false;
    ocrRunning = true;
    ocrCurrentPage = pageNumbers[0];
    $('#ocr-start').disabled = true;
    $('#ocr-cancel').hidden = false;
    $('#ocr-progress-wrap').hidden = false;
    setOcrStatus('Cargando el motor local y los datos de idioma…', 0);
    try {
      const Tesseract = await loadTesseract();
      if (ocrCancelled || pdfDocument !== docAtStart) return;
      const base = new URL('./vendor/tesseract/', import.meta.url).href;
      activeOcrWorker = await Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}core/tesseract-core-lstm.wasm.js`,
        langPath: `${base}languages/4.0.0_best_int/`,
        gzip: true,
        workerBlobURL: false,
        logger: (message) => {
          if (message.status === 'recognizing text' && Number.isFinite(message.progress)) {
            const current = Math.max(1, pageNumbers.indexOf(ocrCurrentPage) + 1);
            const progress = ((current - 1) + message.progress) / pageNumbers.length;
            setOcrStatus(`Página ${current} de ${pageNumbers.length}: reconociendo texto…`, progress);
          }
        },
      });
      for (let index = 0; index < pageNumbers.length; index += 1) {
        if (ocrCancelled || pdfDocument !== docAtStart) break;
        const number = pageNumbers[index];
        const pageInfo = pages[number - 1];
        if (!pageInfo || pageInfo.blank) { skipped += 1; continue; }
        const pdfPage = await pdfDocument.getPage(pageInfo.sourceIndex + 1);
        const native = await pdfPage.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        if (native.items.some((item) => item.str?.trim())) { skipped += 1; continue; }
        ocrCurrentPage = number;
        setOcrStatus(`Preparando página ${index + 1} de ${pageNumbers.length}…`, index / pageNumbers.length);
        const viewport = pdfPage.getViewport({ scale: 2, rotation: pageInfo.rotation ?? pdfPage.rotate });
        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = Math.ceil(viewport.width);
        ocrCanvas.height = Math.ceil(viewport.height);
        const ocrContext = ocrCanvas.getContext('2d', { alpha: false });
        if (!ocrContext) throw new Error('El navegador no pudo crear el área temporal para el reconocimiento.');
        ocrContext.fillStyle = '#ffffff';
        ocrContext.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
        await pdfPage.render({ canvasContext: ocrContext, viewport }).promise;
        if (ocrCancelled || !activeOcrWorker) { ocrCanvas.width = 0; ocrCanvas.height = 0; break; }
        const { data } = await activeOcrWorker.recognize(ocrCanvas, {}, { blocks: true, text: true });
        const viewportOne = pdfPage.getViewport({ scale: 1, rotation: pageInfo.rotation ?? pdfPage.rotate });
        const scaleX = viewport.width / viewportOne.width, scaleY = viewport.height / viewportOne.height;
        const textRegions = extractOcrLines(data);
        const appearances = textRegions.map(({ bbox }) => estimateOcrAppearance(ocrCanvas, bbox));
        ocrCanvas.width = 0; ocrCanvas.height = 0;
        pageInfo.ocrBlocks = textRegions.map(({ level, text, confidence, bbox }, regionIndex) => ({
          id: uid(), level, text, confidence,
          x: Math.max(0, bbox.x0 / scaleX - .75), y: Math.max(0, bbox.y0 / scaleY - .5),
          width: Math.max(4, (bbox.x1 - bbox.x0) / scaleX + 1.5), height: Math.max(5, (bbox.y1 - bbox.y0) / scaleY + 1),
          family: 'Helvetica', fontSize: Math.max(7, ((bbox.y1 - bbox.y0) / scaleY) * .78),
          ...appearances[regionIndex],
          italic: false, align: 'left', lineHeight: 1.12, rotation: 0, isOcr: true,
        }));
        found += textRegions.length;
        foundLines += textRegions.filter((region) => region.level === 'line').length;
        setOcrStatus(`Página ${index + 1} de ${pageNumbers.length}: ${textRegions.filter((region) => region.level === 'line').length} líneas, palabras y párrafos reconocidos.`, (index + 1) / pageNumbers.length);
      }
      if (pdfDocument === docAtStart && found) {
        recordHistory();
        changesCommitted = true;
        await renderCurrentPage();
        if (pages[currentPage - 1]?.ocrBlocks?.length && textEditMode) await renderTextTargets();
      }
      if (!ocrCancelled && pdfDocument === docAtStart) {
        if (found) {
          const detail = skipped ? ` ${skipped} página(s) omitidas por contener texto seleccionable o estar en blanco.` : '';
          setOcrStatus(`OCR listo: ${foundLines} líneas y regiones de palabras/párrafos detectadas. Elige el nivel y activa «Editar texto» para revisarlas.${detail}`, 1);
          showStatus(`OCR finalizado. Se detectaron ${foundLines} líneas y regiones que puedes revisar y corregir.`, 'success');
        } else {
          setOcrStatus(`No se detectaron líneas de texto. Comprueba la calidad del escaneo o el idioma elegido.${skipped ? ` ${skipped} página(s) ya tenían texto seleccionable o estaban en blanco.` : ''}`, 0);
          showStatus('El OCR terminó, pero no encontró texto reconocible en las páginas elegidas.', 'error');
        }
      }
    } catch (error) {
      if (ocrCancelled) return;
      if (pdfDocument === docAtStart && found && !changesCommitted) {
        recordHistory();
        changesCommitted = true;
        await renderCurrentPage();
      }
      setOcrStatus(`No se pudo completar el OCR: ${error?.message || 'error de reconocimiento'}`, null);
      showStatus(`No se pudo completar el OCR: ${error?.message || 'error de reconocimiento'}`, 'error');
    } finally {
      const worker = activeOcrWorker;
      activeOcrWorker = null;
      if (worker) { try { await worker.terminate(); } catch (_) { /* Se libera el worker al finalizar. */ } }
      ocrRunning = false;
      if (ocrCancelled && pdfDocument === docAtStart && found && !changesCommitted) {
        recordHistory();
        changesCommitted = true;
        await renderCurrentPage();
        if (textEditMode) await renderTextTargets();
        setOcrStatus(`OCR cancelado. Se conservaron ${foundLines} líneas ya reconocidas; aún puedes corregirlas.`, null);
      }
      $('#ocr-cancel').hidden = true;
      $('#ocr-start').disabled = !pdfDocument;
      if (!ocrCancelled && $('#ocr-progress').value >= 1) $('#ocr-progress-wrap').hidden = true;
    }
  }

  function makeEditableTextBlocks(fragments) {
    const ordered = fragments.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const lines = [];
    for (const fragment of ordered) {
      const rect = fragment.rect;
      const line = lines.find((candidate) => Math.abs(candidate.y - rect.y) <= Math.max(2, rect.height * .32)
        && Math.abs(candidate.rotation - rect.rotation) < 2);
      if (line) {
        line.fragments.push(fragment);
        line.y = Math.min(line.y, rect.y);
        line.bottom = Math.max(line.bottom, rect.y + rect.height);
      } else {
        lines.push({ y: rect.y, bottom: rect.y + rect.height, rotation: rect.rotation, fragments: [fragment] });
      }
    }
    for (const line of lines) {
      line.fragments.sort((a, b) => a.rect.x - b.rect.x);
      let text = '';
      let previous = null;
      line.runs = [];
      for (const fragment of line.fragments) {
        const raw = fragment.text;
        const leading = /^\s/.test(raw), trailing = /\s$/.test(raw);
        const gap = previous ? fragment.rect.x - (previous.rect.x + previous.rect.width) : 0;
        if (previous && text && !/\s$/.test(text) && !leading && gap > Math.max(1.5, fragment.rect.height * .2)) text += ' ';
        const clean = raw.replace(/^\s+/, '');
        const start = text.length;
        text += clean;
        line.runs.push({ fragment, start, end: text.length });
        if (trailing && !text.endsWith(' ')) text += ' ';
        previous = fragment;
      }
      line.text = text.trimEnd();
      line.x = Math.min(...line.fragments.map((item) => item.rect.x));
      line.right = Math.max(...line.fragments.map((item) => item.rect.x + item.rect.width));
      line.width = Math.max(1, line.right - line.x);
      line.height = Math.max(...line.fragments.map((item) => item.rect.height));
      line.fontSize = line.fragments.reduce((sum, item) => sum + item.rect.fontSize, 0) / line.fragments.length;
      const first = line.fragments[0];
      const info = first.fontMeta;
      const styleSignature = `${first.fontName || ''} ${info?.name || ''} ${info?.loadedName || ''} ${first.style?.fontWeight || ''} ${first.style?.fontStyle || ''}`;
      line.family = inferTextFamily(first.style, `${styleSignature} ${info?.cssFontInfo?.fontFamily || ''}`);
      line.bold = Boolean(info?.bold || info?.black || Number(first.style?.fontWeight || info?.cssFontInfo?.fontWeight) >= 600) || /bold|black|heavy|demi/i.test(styleSignature);
      line.italic = Boolean(info?.italic) || /italic|oblique/i.test(styleSignature);
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    const groups = [];
    for (const line of lines) {
      const group = groups.at(-1);
      if (!group) { groups.push({ lines: [line] }); continue; }
      const previous = group.lines.at(-1);
      const gap = line.y - previous.y;
      const sameStyle = line.family === previous.family && line.bold === previous.bold && line.italic === previous.italic
        && Math.abs(line.fontSize - previous.fontSize) <= Math.max(1.5, previous.fontSize * .12)
        && Math.abs(line.rotation - previous.rotation) < 2;
      const leftAligned = Math.abs(line.x - previous.x) <= Math.max(7, previous.fontSize * 1.4);
      const centered = Math.abs((line.x + line.right) / 2 - (previous.x + previous.right) / 2) <= Math.max(8, previous.fontSize * .85);
      const rightAligned = Math.abs(line.right - previous.right) <= Math.max(7, previous.fontSize * 1.2);
      if (sameStyle && gap > 0 && gap <= previous.fontSize * 2.35 && (leftAligned || centered || rightAligned)) group.lines.push(line);
      else groups.push({ lines: [line] });
    }
    return groups.map(({ lines: blockLines }) => {
      const x = Math.min(...blockLines.map((line) => line.x));
      const right = Math.max(...blockLines.map((line) => line.right));
      const y = Math.min(...blockLines.map((line) => line.y));
      const bottom = Math.max(...blockLines.map((line) => line.bottom));
      const fontSize = blockLines.reduce((sum, line) => sum + line.fontSize, 0) / blockLines.length;
      const lineGaps = blockLines.slice(1).map((line, index) => (line.y - blockLines[index].y) / Math.max(1, fontSize)).filter((value) => value > .5 && value < 3);
      const lineHeight = lineGaps.length ? Math.max(.8, Math.min(2.5, lineGaps.reduce((sum, value) => sum + value, 0) / lineGaps.length)) : 1.2;
      const leftVariance = Math.max(...blockLines.map((line) => line.x)) - Math.min(...blockLines.map((line) => line.x));
      const centerVariance = Math.max(...blockLines.map((line) => (line.x + line.right) / 2)) - Math.min(...blockLines.map((line) => (line.x + line.right) / 2));
      const rightVariance = Math.max(...blockLines.map((line) => line.right)) - Math.min(...blockLines.map((line) => line.right));
      let align = 'left';
      if (blockLines.length > 1 && leftVariance > fontSize * .75) {
        if (centerVariance < fontSize * .7) align = 'center';
        else if (rightVariance < fontSize * .7) align = 'right';
      }
      let offset = 0;
      const mappedLines = blockLines.map((line, index) => {
        const start = offset;
        offset += line.text.length;
        if (index < blockLines.length - 1) offset += 1;
        return { text: line.text, start, end: start + line.text.length, x: line.x, y: line.y, width: line.width, height: line.height };
      });
      return {
        text: blockLines.map((line) => line.text).join('\n'),
        lines: mappedLines,
        x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y),
        fontSize, lineHeight, align,
        family: blockLines[0].family, bold: blockLines[0].bold, italic: blockLines[0].italic,
        rotation: blockLines[0].rotation,
      };
    });
  }

  function textCaretIndex(event, block, target) {
    if (Math.abs(block.rotation) > .5 || !block.lines?.length) {
      const bounds = target.getBoundingClientRect();
      return Math.max(0, Math.min(block.text.length, Math.round(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * block.text.length)));
    }
    const pageBounds = pageElement.getBoundingClientRect();
    const x = (event.clientX - pageBounds.left) / zoom;
    const y = (event.clientY - pageBounds.top) / zoom;
    const line = block.lines.reduce((closest, candidate) => {
      const candidateDistance = Math.abs(y - (candidate.y + candidate.height / 2));
      const closestDistance = Math.abs(y - (closest.y + closest.height / 2));
      return candidateDistance < closestDistance ? candidate : closest;
    }, block.lines[0]);
    const ratio = Math.max(0, Math.min(1, (x - line.x) / Math.max(1, line.width)));
    const measure = document.createElement('canvas').getContext('2d');
    const family = block.family === 'Times Roman' ? '"Times New Roman",serif' : block.family === 'Courier' ? '"Courier New",monospace' : 'Arial,sans-serif';
    measure.font = `${block.italic ? 'italic ' : ''}${block.bold ? '700 ' : '400 '}${block.fontSize}px ${family}`;
    const desiredWidth = Math.max(0, ratio * line.width);
    let charIndex = 0, measuredWidth = 0, distance = Infinity;
    const characters = [...line.text];
    for (let index = 0; index < characters.length; index += 1) {
      const nextIndex = charIndex + characters[index].length;
      const nextWidth = measure.measureText(line.text.slice(0, nextIndex)).width;
      const nextDistance = Math.abs(nextWidth - desiredWidth);
      if (nextDistance > distance) break;
      charIndex = nextIndex;
      measuredWidth = nextWidth;
      distance = nextDistance;
    }
    if (desiredWidth > measuredWidth && charIndex < line.text.length) charIndex += [...line.text.slice(charIndex)][0]?.length || 0;
    return Math.max(0, Math.min(block.text.length, line.start + charIndex));
  }

  function selectTextItem(item, caretIndex) {
    pendingReplacement = { ...item, sourceX: item.x, sourceY: item.y, id: `pending-${uid()}`, type: 'replace-text' };
    pendingReplacementInitial = Object.fromEntries(['text', 'family', 'fontSize', 'color', 'coverColor', 'bold', 'italic', 'align', 'lineHeight', 'x', 'y', 'width', 'height', 'rotation', 'opacity'].map((key) => [key, item[key]]));
    textSelectionLayer.replaceChildren();
    $('#text-edit-prompt').textContent = `Texto seleccionado: “${item.originalText}”.`;
    $('#text-edit-form').hidden = false;
    $('#replacement-size').value = String(Number(item.fontSize.toFixed(1)));
    $('#replacement-family').value = item.family;
    $('#replacement-color').value = item.color;
    $('#replacement-cover').value = item.coverColor;
    $('#replacement-x').value = String(Number(item.x.toFixed(1)));
    $('#replacement-y').value = String(Number(item.y.toFixed(1)));
    $('#replacement-width').value = String(Number(item.width.toFixed(1)));
    $('#replacement-height').value = String(Number(item.height.toFixed(1)));
    $('#replacement-align').value = item.align;
    $('#replacement-bold').checked = item.bold;
    $('#replacement-italic').checked = item.italic;
    $('#replacement-line-height').value = String(Number((item.lineHeight || 1.2).toFixed(2)));
    updatePendingReplacement(false);
    renderAnnotations(false);
    const annotation = layer.querySelector(`[data-annotation-id="${CSS.escape(pendingReplacement.id)}"]`);
    annotation?.classList.add('annotation--editing');
    createInlineTextEditor(caretIndex);
  }

  function updatePendingReplacement(render = true) {
    if (!pendingReplacement) return;
    if (inlineTextEditor) pendingReplacement.text = inlineTextEditor.value;
    pendingReplacement.fontSize = Math.max(4, Math.min(144, Number($('#replacement-size').value) || 12));
    pendingReplacement.family = $('#replacement-family').value;
    pendingReplacement.color = $('#replacement-color').value;
    pendingReplacement.coverColor = $('#replacement-cover').value;
    pendingReplacement.bold = $('#replacement-bold').checked;
    pendingReplacement.italic = $('#replacement-italic').checked;
    pendingReplacement.align = $('#replacement-align').value;
    pendingReplacement.lineHeight = Math.max(.8, Math.min(2.5, Number($('#replacement-line-height').value) || 1.2));
    pendingReplacement.x = Number($('#replacement-x').value) || 0;
    pendingReplacement.y = Number($('#replacement-y').value) || 0;
    const requestedWidth = Math.max(8, Number($('#replacement-width').value) || 8);
    const requestedHeight = Math.max(6, Number($('#replacement-height').value) || 6);
    const measureCanvas = document.createElement('canvas');
    const measure = measureCanvas.getContext('2d');
    const family = pendingReplacement.family === 'Times Roman' ? '"Times New Roman", serif' : pendingReplacement.family === 'Courier' ? '"Courier New", monospace' : 'Arial, sans-serif';
    measure.font = `${pendingReplacement.italic ? 'italic ' : ''}${pendingReplacement.bold ? '700 ' : '400 '}${pendingReplacement.fontSize}px ${family}`;
    const available = Math.max(8, (activePage()?.width || 600) - pendingReplacement.x - 6);
    const requiredLineWidth = Math.max(0, ...pendingReplacement.text.split('\n').map((line) => measure.measureText(line).width));
    const desiredWidth = Math.max(requestedWidth, requiredLineWidth + 4);
    const ocrWidthLimit = Math.max(requestedWidth, (pendingReplacement.sourceWidth || requestedWidth) + Math.max(16, pendingReplacement.fontSize * 1.25));
    pendingReplacement.width = Math.min(available, pendingReplacement.isOcr ? Math.min(desiredWidth, ocrWidthLimit) : desiredWidth);
    const wrapWidth = Math.max(4, pendingReplacement.width - 4);
    const wrappedLines = wrapTextToWidth(pendingReplacement.text, (text) => measure.measureText(text).width, wrapWidth);
    const lineCount = wrappedLines.length;
    pendingReplacement.height = Math.max(requestedHeight, lineCount * pendingReplacement.fontSize * pendingReplacement.lineHeight);
    $('#replacement-width').value = String(Number(pendingReplacement.width.toFixed(1)));
    $('#replacement-height').value = String(Number(pendingReplacement.height.toFixed(1)));
    syncInlineTextEditor();
    updateReplacementOverlapWarning();
    if (render) renderAnnotations(false);
  }

  function replacementOverlapsOtherText(item = pendingReplacement) {
    if (!item) return false;
    return selectableTextRegions.some((region) => {
      if (region.text === item.originalText && Math.abs(region.x - (item.sourceX ?? item.x)) < 1.5 && Math.abs(region.y - (item.sourceY ?? item.y)) < 1.5) return false;
      return item.x < region.x + region.width && item.x + item.width > region.x
        && item.y < region.y + region.height && item.y + item.height > region.y;
    });
  }

  function updateReplacementOverlapWarning() {
    const prompt = $('#text-edit-prompt');
    if (!prompt || !pendingReplacement) return false;
    const overlap = replacementOverlapsOtherText();
    prompt.classList.toggle('has-warning', overlap);
    if (overlap) prompt.textContent = 'Advertencia: el área del texto se superpone con otro bloque detectado. Reduce la tipografía o ajusta la posición antes de aplicar; revisa el resultado antes de exportar.';
    else if (pendingReplacement.isOcr && !pendingReplacement.coverEstimateReliable) prompt.textContent = `Texto seleccionado: “${pendingReplacement.originalText}”. El fondo tiene variaciones; ajusta «Cobertura visual» y el color del texto en Propiedades, y revisa el resultado antes de exportar.`;
    else prompt.textContent = `Texto seleccionado: “${pendingReplacement.originalText}”.`;
    return overlap;
  }

  async function toggleTextEditMode(force = !textEditMode) {
    if (!pdfDocument) return;
    if (force && markupMode) toggleMarkupMode(false);
    if (!force && pendingReplacement) {
      inlineTextEditor?.remove();
      inlineTextEditor = null;
      pendingReplacement = null;
      pendingReplacementInitial = null;
      $('#text-edit-form').hidden = true;
    }
    textEditMode = force;
    $('#edit-existing-text').setAttribute('aria-pressed', String(textEditMode));
    $('#edit-existing-text').classList.toggle('is-active', textEditMode);
    $('#text-edit-panel').hidden = !textEditMode;
    textSelectionLayer.hidden = !textEditMode;
    layer.classList.toggle('is-inactive', textEditMode);
    if (textEditMode) {
      $('#text-edit-form').hidden = !pendingReplacement;
      $('#text-edit-prompt').textContent = 'Buscando textos seleccionables…';
      await renderTextTargets();
    } else {
      textSelectionLayer.replaceChildren();
      pendingReplacement = null;
      pendingReplacementInitial = null;
      $('#text-edit-form').hidden = true;
      renderAnnotations(false);
    }
  }

  function stopTextEditMode() {
    textEditMode = false;
    pendingReplacement = null;
    pendingReplacementInitial = null;
    inlineTextEditor?.remove();
    inlineTextEditor = null;
    if (textSelectionLayer) { textSelectionLayer.hidden = true; textSelectionLayer.replaceChildren(); }
    layer?.classList.remove('is-inactive');
    const button = $('#edit-existing-text');
    if (button) { button.setAttribute('aria-pressed', 'false'); button.classList.remove('is-active'); }
    const panel = $('#text-edit-panel');
    if (panel) panel.hidden = true;
    const form = $('#text-edit-form');
    if (form) form.hidden = true;
  }

  function applyTextReplacement() {
    if (!pendingReplacement) return;
    pendingReplacement.text = inlineTextEditor?.value ?? pendingReplacement.text;
    const hasOverlap = replacementOverlapsOtherText();
    const replacement = { ...pendingReplacement, id: uid() };
    delete replacement.pageNumber;
    delete replacement.originalText;
    delete replacement.sourceX;
    delete replacement.sourceY;
    delete replacement.sourceWidth;
    delete replacement.coverEstimateReliable;
    delete replacement.isOcr;
    pendingReplacement = null;
    pendingReplacementInitial = null;
    inlineTextEditor?.remove();
    inlineTextEditor = null;
    addAnnotation(replacement);
    stopTextEditMode();
    showStatus(hasOverlap
      ? 'Se aplicó la sustitución visual, pero su área se superpone con otro texto detectado. Revisa el PDF antes de exportarlo.'
      : 'Se agregó una sustitución visual. El texto original puede permanecer en la estructura del PDF.', hasOverlap ? 'error' : 'info');
  }

  function cancelPendingReplacement() {
    pendingReplacement = null;
    pendingReplacementInitial = null;
    inlineTextEditor?.remove();
    inlineTextEditor = null;
    $('#text-edit-form').hidden = true;
    renderAnnotations(false);
    if (textEditMode) renderTextTargets();
  }

  function insertImage(dataUrl, { isSignature = false } = {}) {
    const image = new Image();
    image.onload = () => {
      const maxWidth = Math.min(190, Math.max(70, (activePage()?.width || 600) / 2));
      const width = Math.min(maxWidth, image.naturalWidth || maxWidth);
      const height = Math.max(24, width * (image.naturalHeight / Math.max(1, image.naturalWidth)));
      const position = nextPosition(width, height);
      addAnnotation({ id: uid(), type: 'image', dataUrl, isSignature, ...position, width, height, aspectRatio: width / height, rotation: 0, opacity: 1 });
    };
    image.onerror = () => showStatus('El navegador no pudo leer esta imagen.', 'error');
    image.src = dataUrl;
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
      reader.readAsDataURL(file);
    });
  }

  async function handleImageFile(file, isSignature) {
    if (!file) return;
    const allowed = ['image/png', 'image/jpeg'];
    if (!allowed.includes(file.type) || file.size > 15 * 1024 * 1024) {
      showStatus('Selecciona un archivo PNG o JPG de hasta 15 MB.', 'error');
      return;
    }
    try { insertImage(await fileAsDataUrl(file), { isSignature }); }
    catch (error) { showStatus(error.message, 'error'); }
    finally { inputImage.value = ''; }
  }

  function signatureDb() {
    if (signatureDbPromise) return signatureDbPromise;
    signatureDbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB no está disponible en este navegador.')); return; }
      const request = indexedDB.open('suite-pdf-signatures-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('signatures', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB.'));
    });
    return signatureDbPromise;
  }

  async function signatureTransaction(mode, action) {
    const db = await signatureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('signatures', mode);
      const store = tx.objectStore('signatures');
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Error de IndexedDB.'));
      tx.onerror = () => reject(tx.error || new Error('No se pudo completar el almacenamiento local.'));
    });
  }

  async function listSignatures() { return (await signatureTransaction('readonly', (store) => store.getAll())) || []; }
  async function saveSignature(name, dataUrl) {
    await signatureTransaction('readwrite', (store) => store.put({ id: uid(), name, dataUrl, createdAt: new Date().toISOString() }));
  }
  async function removeSignature(id) { await signatureTransaction('readwrite', (store) => store.delete(id)); }

  async function renderSignatureLibrary() {
    const container = $('#signature-library');
    try {
      const signatures = await listSignatures();
      container.replaceChildren();
      if (!signatures.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Todavía no hay firmas guardadas.'; container.append(p); return; }
      signatures.forEach((signature) => {
        const row = document.createElement('div'); row.className = 'saved-signature';
        const image = document.createElement('img'); image.src = signature.dataUrl; image.alt = `Firma guardada: ${signature.name}`;
        const add = document.createElement('button'); add.type = 'button'; add.textContent = signature.name; add.title = 'Insertar firma en la página actual'; add.className = 'btn btn--secondary'; add.addEventListener('click', () => insertImage(signature.dataUrl, { isSignature: true }));
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Eliminar firma ${signature.name}`); remove.addEventListener('click', async () => { try { await removeSignature(signature.id); await renderSignatureLibrary(); } catch (_) { showStatus('No se pudo eliminar la firma local.', 'error'); } });
        row.append(image, add, remove); container.append(row);
      });
    } catch (_) {
      container.innerHTML = '<p class="hint">IndexedDB no está disponible. Puedes insertar firmas, pero no guardarlas para reutilizar.</p>';
    }
  }

  function setupSignaturePad() {
    const pad = $('#signature-pad');
    const brush = pad.getContext('2d');
    const point = (event) => {
      const rect = pad.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * pad.width / rect.width, y: (event.clientY - rect.top) * pad.height / rect.height };
    };
    pad.addEventListener('pointerdown', (event) => {
      signaturePointerDown = true; pad.setPointerCapture(event.pointerId);
      const p = point(event); brush.beginPath(); brush.moveTo(p.x, p.y); brush.strokeStyle = $('#pen-color').value; brush.lineWidth = Number($('#pen-width').value); brush.lineCap = 'round'; brush.lineJoin = 'round';
      brush.lineTo(p.x + .1, p.y + .1); brush.stroke();
    });
    pad.addEventListener('pointermove', (event) => {
      if (!signaturePointerDown) return;
      const p = point(event); brush.lineTo(p.x, p.y); brush.strokeStyle = $('#pen-color').value; brush.lineWidth = Number($('#pen-width').value); brush.lineCap = 'round'; brush.lineJoin = 'round'; brush.stroke();
    });
    const stop = () => { signaturePointerDown = false; };
    pad.addEventListener('pointerup', stop); pad.addEventListener('pointercancel', stop); pad.addEventListener('lostpointercapture', stop);
    $('#clear-signature').addEventListener('click', () => brush.clearRect(0, 0, pad.width, pad.height));
    $('#close-signature').addEventListener('click', () => $('#signature-dialog').close());
    $('#use-signature').addEventListener('click', async () => {
      if (!activePage()) return;
      const dataUrl = pad.toDataURL('image/png');
      insertImage(dataUrl, { isSignature: true });
      const name = $('#signature-name').value.trim();
      if (name) { try { await saveSignature(name, dataUrl); await renderSignatureLibrary(); } catch (_) { showStatus('Firma insertada. No se pudo guardarla para reutilizar.', 'error'); } }
      brush.clearRect(0, 0, pad.width, pad.height); $('#signature-name').value = ''; $('#signature-dialog').close();
    });
    $('#signature-dialog').addEventListener('click', (event) => { if (event.target === $('#signature-dialog')) $('#signature-dialog').close(); });
  }

  function handleLayerPointerDown(event) {
    if (markupMode) { startMarkupDraw(event); return; }
    const element = event.target.closest('.annotation');
    if (!element) { selectedId = null; renderAnnotations(); return; }
    const item = activeAnnotations().find((annotation) => annotation.id === element.dataset.annotationId);
    if (!item) return;
    selectedId = item.id;
    const resize = Boolean(event.target.closest('.resize-handle'));
    recordHistory();
    dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: item.x, y: item.y, width: item.width, height: item.height, resize, item };
    layer.setPointerCapture(event.pointerId);
    renderAnnotations();
    event.preventDefault();
  }

  function handleLayerPointerMove(event) {
    if (drawingState && drawingState.pointerId === event.pointerId) {
      const point = layerPoint(event);
      drawingState.end = point;
      if (drawingState.type === 'freehand') drawingState.points.push(point);
      renderAnnotations(false);
      return;
    }
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const dx = (event.clientX - dragState.startX) / zoom;
    const dy = (event.clientY - dragState.startY) / zoom;
    if (dragState.resize) {
      let width = Math.max(24, dragState.width + dx);
      let height = Math.max(24, dragState.height + dy);
      if (dragState.item.type === 'image') {
        const ratio = dragState.item.aspectRatio || dragState.width / Math.max(1, dragState.height);
        if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio; else width = height * ratio;
      }
      dragState.item.width = width; dragState.item.height = height;
    } else {
      dragState.item.x = Math.max(0, Math.min((pageElement.clientWidth / zoom) - dragState.item.width, dragState.x + dx));
      dragState.item.y = Math.max(0, Math.min((pageElement.clientHeight / zoom) - dragState.item.height, dragState.y + dy));
    }
    renderAnnotations();
  }

  function handleLayerPointerUp(event) {
    if (drawingState && (!event || drawingState.pointerId === event.pointerId)) {
      const state = drawingState;
      drawingState = null;
      const distance = Math.hypot(state.end.x - state.start.x, state.end.y - state.start.y);
      if (distance < 2 && state.type !== 'freehand') { renderAnnotations(false); return; }
      addAnnotation(markupAnnotationFromState(state));
      return;
    }
    if (dragState) recordHistory();
    dragState = null;
  }

  async function embedAnnotations(pdfDoc, pageInfos = pages) {
    const pdfPages = pdfDoc.getPages();
    const embedded = new Map();
    for (let pageIndex = 0; pageIndex < pageInfos.length; pageIndex += 1) {
      const pageInfo = pageInfos[pageIndex];
      const annotations = pageInfo.annotations || [];
      if (!annotations.length) continue;
      const pdfPage = pdfPages[pageIndex];
      const pdfJsPage = pageInfo.blank ? null : await pdfDocument.getPage(pageInfo.sourceIndex + 1);
      const baseViewport = pdfJsPage
        ? pdfJsPage.getViewport({ scale: 1, rotation: pageInfo.rotation ?? pdfJsPage.rotate })
        : { convertToPdfPoint: (x, y) => [x, pageInfo.height - y] };
      const rotate = ((pageInfo.rotation || 0) % 360 + 360) % 360;
      for (const item of annotations) {
        if (['highlight', 'line', 'arrow', 'rectangle', 'ellipse', 'freehand'].includes(item.type)) {
          await embedMarkup(pdfPage, baseViewport, item);
          continue;
        }
        const topLeft = baseViewport.convertToPdfPoint(item.x, item.y);
        const topRight = baseViewport.convertToPdfPoint(item.x + item.width, item.y);
        const bottomLeft = baseViewport.convertToPdfPoint(item.x, item.y + item.height);
        const x = Math.min(topLeft[0], topRight[0], bottomLeft[0]);
        const y = Math.min(topLeft[1], topRight[1], bottomLeft[1]);
        const width = Math.max(1, Math.max(topLeft[0], topRight[0], bottomLeft[0]) - x);
        const height = Math.max(1, Math.max(topLeft[1], topRight[1], bottomLeft[1]) - y);
        const rotation = (Number(item.rotation) || 0) - rotate;
        if (['text', 'stamp', 'replace-text'].includes(item.type)) {
          if (item.type === 'replace-text') {
            const cover = parseHex(item.coverColor || '#ffffff');
            const coverPadding = Math.max(0, Math.min(4, Number(item.coverPadding) || 0));
            const coverLeft = Math.max(0, item.x - coverPadding);
            const coverTop = Math.max(0, item.y - coverPadding);
            const coverRight = Math.min(pageInfo.width, item.x + item.width + coverPadding);
            const coverBottom = Math.min(pageInfo.height, item.y + item.height + coverPadding);
            const coverTopLeft = baseViewport.convertToPdfPoint(coverLeft, coverTop);
            const coverTopRight = baseViewport.convertToPdfPoint(coverRight, coverTop);
            const coverBottomLeft = baseViewport.convertToPdfPoint(coverLeft, coverBottom);
            const coverX = Math.min(coverTopLeft[0], coverTopRight[0], coverBottomLeft[0]);
            const coverY = Math.min(coverTopLeft[1], coverTopRight[1], coverBottomLeft[1]);
            const coverWidth = Math.max(1, Math.max(coverTopLeft[0], coverTopRight[0], coverBottomLeft[0]) - coverX);
            const coverHeight = Math.max(1, Math.max(coverTopLeft[1], coverTopRight[1], coverBottomLeft[1]) - coverY);
            pdfPage.drawRectangle({ x: coverX, y: coverY, width: coverWidth, height: coverHeight, color: rgb(cover.r, cover.g, cover.b), opacity: 1, rotate: degrees(rotation) });
          }
          if (item.type === 'stamp') {
            const stampColor = parseHex(item.color || '#c0392b');
            pdfPage.drawRectangle({ x, y, width, height, borderColor: rgb(stampColor.r, stampColor.g, stampColor.b), borderWidth: Number(item.strokeWidth) || 2, borderOpacity: item.opacity ?? .8, rotate: degrees(rotation) });
          }
          const fontName = fontNameFor(item.family, item.bold, item.italic);
          let font;
          try { font = await pdfDoc.embedFont(StandardFonts[fontName]); }
          catch (_) { font = await pdfDoc.embedFont(StandardFonts.Helvetica); }
          const color = parseHex(item.color);
          const textSize = Math.max(6, Math.min(96, Number(item.fontSize) || 12));
          const lines = wrapPdfText(String(item.text || ''), font, textSize, width);
          const lineHeight = textSize * (item.lineHeight || 1.2);
          const boxTop = Math.max(topLeft[1], bottomLeft[1]);
          lines.forEach((line, lineIndex) => {
            const lineWidth = font.widthOfTextAtSize(line, textSize);
            let textX = x;
            if (item.align === 'center') textX += Math.max(0, (width - lineWidth) / 2);
            else if (item.align === 'right') textX += Math.max(0, width - lineWidth);
            const textY = boxTop - textSize - lineIndex * lineHeight;
            pdfPage.drawText(line, { x: textX, y: textY, size: textSize, font, color: rgb(color.r, color.g, color.b), opacity: item.opacity ?? 1, rotate: degrees(rotation) });
          });
        } else {
          let image = embedded.get(item.dataUrl);
          if (!image) {
            const bytes = dataUrlBytes(item.dataUrl);
            image = item.dataUrl.startsWith('data:image/png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
            embedded.set(item.dataUrl, image);
          }
          pdfPage.drawImage(image, { x, y, width, height, opacity: item.opacity ?? 1, rotate: degrees(rotation) });
        }
      }
    }
  }

  async function embedMarkup(pdfPage, viewport, item) {
    const color = parseHex(item.color || '#d23f31');
    const stroke = rgb(color.r, color.g, color.b);
    const toPoint = (x, y) => viewport.convertToPdfPoint(x, y);
    const corners = [toPoint(item.x, item.y), toPoint(item.x + item.width, item.y), toPoint(item.x, item.y + item.height), toPoint(item.x + item.width, item.y + item.height)];
    const x = Math.min(...corners.map((point) => point[0])), y = Math.min(...corners.map((point) => point[1]));
    const width = Math.max(1, Math.max(...corners.map((point) => point[0])) - x), height = Math.max(1, Math.max(...corners.map((point) => point[1])) - y);
    const opacity = Number(item.opacity ?? (item.type === 'highlight' ? .36 : 1));
    const thickness = Math.max(1, Number(item.strokeWidth) || 3);
    if (item.type === 'highlight') {
      pdfPage.drawRectangle({ x, y, width, height, color: stroke, opacity, borderOpacity: 0 });
    } else if (item.type === 'rectangle') {
      pdfPage.drawRectangle({ x, y, width, height, color: item.fill ? stroke : undefined, opacity: item.fill ? opacity : 0, borderColor: stroke, borderWidth: thickness, borderOpacity: opacity, rotate: degrees(item.rotation || 0) });
    } else if (item.type === 'ellipse') {
      pdfPage.drawEllipse({ x: x + width / 2, y: y + height / 2, xScale: width / 2, yScale: height / 2, color: item.fill ? stroke : undefined, opacity: item.fill ? opacity : 0, borderColor: stroke, borderWidth: thickness, borderOpacity: opacity, rotate: degrees(item.rotation || 0) });
    } else {
      const points = item.points?.length ? item.points : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const pdfPoints = points.map((point) => toPoint(item.x + point.x * item.width, item.y + point.y * item.height));
      for (let index = 1; index < pdfPoints.length; index += 1) {
        pdfPage.drawLine({ start: { x: pdfPoints[index - 1][0], y: pdfPoints[index - 1][1] }, end: { x: pdfPoints[index][0], y: pdfPoints[index][1] }, thickness, color: stroke, opacity });
      }
      if (item.type === 'arrow' && pdfPoints.length >= 2) {
        const start = pdfPoints[pdfPoints.length - 2], end = pdfPoints[pdfPoints.length - 1];
        const angle = Math.atan2(end[1] - start[1], end[0] - start[0]), head = Math.max(7, thickness * 3);
        for (const delta of [-Math.PI / 6, Math.PI / 6]) {
          const point = [end[0] - head * Math.cos(angle + delta), end[1] - head * Math.sin(angle + delta)];
          pdfPage.drawLine({ start: { x: end[0], y: end[1] }, end: { x: point[0], y: point[1] }, thickness, color: stroke, opacity });
        }
      }
    }
  }

  function wrapTextToWidth(text, measureWidth, maxWidth) {
    const lines = [];
    String(text).split('\n').forEach((paragraph) => {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && measureWidth(`${line} ${word}`) > maxWidth) { lines.push(line); line = ''; }
        if (measureWidth(word) > maxWidth) {
          if (line) { lines.push(line); line = ''; }
          let chunk = '';
          for (const character of Array.from(word)) {
            if (chunk && measureWidth(chunk + character) > maxWidth) { lines.push(chunk); chunk = character; }
            else chunk += character;
          }
          line = chunk;
        } else line = line ? `${line} ${word}` : word;
      }
      if (line || !paragraph) lines.push(line);
    });
    return lines;
  }

  function wrapPdfText(text, font, size, maxWidth) {
    return wrapTextToWidth(text, (line) => font.widthOfTextAtSize(line, size), maxWidth);
  }

  function fontNameFor(family, bold, italic) {
    if (family === 'Times Roman') return italic ? (bold ? 'TimesRomanBoldItalic' : 'TimesRomanItalic') : (bold ? 'TimesRomanBold' : 'TimesRoman');
    if (family === 'Courier') return italic ? (bold ? 'CourierBoldOblique' : 'CourierOblique') : (bold ? 'CourierBold' : 'Courier');
    return italic ? (bold ? 'HelveticaBoldOblique' : 'HelveticaOblique') : (bold ? 'HelveticaBold' : 'Helvetica');
  }

  function parseHex(value) {
    const match = /^#([\da-f]{6})$/i.exec(value || '');
    const hex = match ? match[1] : '132f52';
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255 };
  }

  function dataUrlBytes(dataUrl) {
    const raw = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  function applyFormValues(pdfDoc) {
    const form = pdfDoc.getForm();
    let skipped = 0;
    for (const field of form.getFields()) {
      const name = field.getName();
      if (!Object.hasOwn(formValues, name)) continue;
      const value = formValues[name];
      try {
        if (typeof field.setText === 'function') field.setText(String(value ?? ''));
        else if (typeof field.check === 'function' && typeof field.uncheck === 'function') value ? field.check() : field.uncheck();
        else if (typeof field.select === 'function') field.select(String(value ?? ''));
        else skipped += 1;
      } catch (_) { skipped += 1; }
    }
    return { form, skipped };
  }

  async function buildPdfBytes(pageInfos = pages) {
    const source = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const { form, skipped } = applyFormValues(source);
    const sourcePages = source.getPages();
    let sameAsSource = pageInfos.length === sourcePages.length && pageInfos.length === pages.length;
    if (sameAsSource) {
      for (let index = 0; index < pageInfos.length; index += 1) {
        const info = pageInfos[index];
        const originalRotation = sourcePages[index].getRotation().angle || 0;
        if (info.blank || info.sourceIndex !== index || (((info.rotation ?? originalRotation) % 360) + 360) % 360 !== ((originalRotation % 360) + 360) % 360) { sameAsSource = false; break; }
      }
    }
    let output = source;
    if (!sameAsSource) {
      if (form.getFields().length) {
        try { form.flatten({ updateFieldAppearances: true }); }
        catch (error) { throw new Error(`No se pueden reorganizar páginas sin perder la apariencia de este formulario: ${error?.message || 'campo no compatible'}`); }
      }
      output = await PDFDocument.create();
      for (const info of pageInfos) {
        if (info.blank) {
          const blank = output.addPage([info.width || 595, info.height || 842]);
          blank.setRotation(degrees(info.rotation || 0));
          continue;
        }
        if (!Number.isInteger(info.sourceIndex) || !sourcePages[info.sourceIndex]) throw new Error('Una página no tiene un origen válido para exportar.');
        const [copied] = await output.copyPages(source, [info.sourceIndex]);
        copied.setRotation(degrees(info.rotation ?? copied.getRotation().angle ?? 0));
        output.addPage(copied);
      }
    } else {
      for (const info of pageInfos) output.getPage(info.sourceIndex).setRotation(degrees(info.rotation ?? 0));
    }
    await embedAnnotations(output, pageInfos);
    const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
    return { bytes, skippedForms: skipped };
  }

  function downloadPdfBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click();
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 30000);
  }

  async function exportPdf() {
    if (!originalBytes || !pdfDocument) return;
    const button = $('#download-pdf'); button.disabled = true;
    showStatus('Preparando una copia del PDF…');
    try {
      const { bytes, skippedForms } = await buildPdfBytes();
      downloadPdfBytes(bytes, `${safeFilename(originalName)}-editado.pdf`);
      exportedHistoryIndex = historyIndex;
      showStatus(skippedForms ? `PDF descargado. ${skippedForms} campo(s) interactivo(s) no se pudieron escribir; comprueba el formulario.` : 'Se descargó una copia del PDF. El original no se modificó.', skippedForms ? 'error' : 'success');
    } catch (error) {
      const message = /encrypted|password/i.test(String(error?.message || error))
        ? 'No se puede exportar un PDF cifrado en esta etapa.'
        : `No se pudo generar el PDF: ${error?.message || 'error al exportar'}`;
      showStatus(message, 'error');
    } finally { button.disabled = !pdfDocument; }
  }

  async function extractPages() {
    const button = $('#download-extract'); button.disabled = true;
    try {
      const selected = parsePageRange($('#extract-range').value);
      const { bytes, skippedForms } = await buildPdfBytes(selected);
      downloadPdfBytes(bytes, `${safeFilename(originalName)}-paginas-extraidas.pdf`);
      $('#extract-dialog').close();
      showStatus(skippedForms ? `Páginas extraídas; ${skippedForms} campo(s) de formulario no se pudieron escribir.` : `${selected.length} página${selected.length === 1 ? '' : 's'} extraída${selected.length === 1 ? '' : 's'} en un PDF independiente.`, skippedForms ? 'error' : 'success');
    } catch (error) { showStatus(`No se pudieron extraer las páginas: ${error?.message || 'rango inválido'}`, 'error'); }
    finally { button.disabled = false; }
  }

  function clearDocument() {
    if (ocrRunning) void cancelOcr();
    pageRenderSequence += 1;
    thumbnailRenderSequence += 1;
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    if (pageRenderTask) { try { pageRenderTask.cancel(); } catch (_) {} pageRenderTask = null; }
    if (loadingTask) loadingTask.destroy().catch(() => {});
    loadingTask = null; pdfDocument = null; originalBytes = null; originalName = ''; pages = []; currentPage = 1; zoom = 1; selectedId = null; history = []; historyIndex = -1;
    exportedHistoryIndex = 0;
    stopTextEditMode();
    if (markupMode) toggleMarkupMode(false);
    drawingState = null; formValues = {}; selectedPagesForExtraction.clear();
    formFieldLayer.replaceChildren();
    layer.replaceChildren(); $('#page-list').innerHTML = '<p class="hint">Abre un PDF para ver sus páginas.</p>';
    $('#file-name').textContent = 'Ningún PDF abierto'; $('#page-count').textContent = '0 páginas'; $('#current-page-label').textContent = '';
    $('#zoom').value = '100'; $('#zoom-value').value = '100%'; $('#zoom-value').textContent = '100%';
    inspectorController?.abort(); inspectorController = null; inspectorEditing = false;
    $('#inspector-empty').hidden = false; $('#inspector-fields').hidden = true; $('#inspector-fields').replaceChildren(); delete $('#inspector-fields').dataset.type;
    pageElement.hidden = true; emptyState.hidden = false; setDocumentControls(false); updateHistoryButtons();
  }

  function finishClosePdf() {
    const confirmation = $('#close-confirm-dialog');
    if (confirmation.open) confirmation.close();
    clearDocument();
    showStatus('PDF cerrado. Puedes abrir otro documento.', 'info');
  }

  function closePdf() {
    if (!pdfDocument) return;
    const pendingEdit = pendingReplacement && pendingReplacementInitial
      && Object.keys(pendingReplacementInitial).some((key) => !Object.is(pendingReplacement[key], pendingReplacementInitial[key]));
    if (historyIndex !== exportedHistoryIndex || pendingEdit) {
      $('#close-confirm-dialog').showModal();
      return;
    }
    finishClosePdf();
  }

  // The visible labels activate the file input natively on pointer/touch.
  // Preserve keyboard activation because a label is not natively tabbable.
  document.addEventListener('keydown', (event) => {
    const trigger = event.target.closest?.('.pdf-file-trigger');
    if (trigger && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      filePicker.click();
    }
  });
  filePicker.addEventListener('change', () => openPdf(filePicker.files?.[0]));
  $('#add-pdf').addEventListener('click', () => mergePicker.click());
  mergePicker.addEventListener('change', () => mergePdf(mergePicker.files?.[0]));
  $('#insert-blank-page').addEventListener('click', insertBlankPage);
  $('#extract-pages').addEventListener('click', openExtractDialog);
  $('#cancel-extract').addEventListener('click', () => $('#extract-dialog').close());
  $('#download-extract').addEventListener('click', extractPages);
  $('#cancel-stamp').addEventListener('click', () => $('#stamp-dialog').close());
  $('#insert-stamp').addEventListener('click', insertStamp);
  $('#stamp-preset').addEventListener('change', () => { $('#stamp-custom-wrap').hidden = $('#stamp-preset').value !== 'custom'; });
  $('#add-stamp').addEventListener('click', openStampDialog);
  $('#markup-toggle').addEventListener('click', () => toggleMarkupMode());
  $('#recognize-ocr').addEventListener('click', () => {
    const panel = $('#ocr-panel');
    panel.hidden = !panel.hidden;
    $('#recognize-ocr').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('#ocr-language').focus();
  });
  $('#ocr-scope').addEventListener('change', () => { $('#ocr-range-wrap').hidden = $('#ocr-scope').value !== 'range'; });
  $('#ocr-start').addEventListener('click', runOcr);
  $('#ocr-cancel').addEventListener('click', cancelOcr);
  $('#ocr-level').addEventListener('change', () => { if (textEditMode) void renderTextTargets(); });
  $('#markup-type').addEventListener('change', () => showStatus(`Herramienta seleccionada: ${$('#markup-type').selectedOptions[0].textContent}. Arrastra sobre la página.`));
  $('#close-pdf').addEventListener('click', closePdf);
  $('#cancel-close-pdf').addEventListener('click', () => $('#close-confirm-dialog').close());
  $('#confirm-close-pdf').addEventListener('click', finishClosePdf);
  $('#download-pdf').addEventListener('click', exportPdf);
  $('#add-text').addEventListener('click', () => { if (markupMode) toggleMarkupMode(false); createText(); });
  $('#edit-existing-text').addEventListener('click', () => toggleTextEditMode());
  $('#text-edit-form').addEventListener('input', () => updatePendingReplacement());
  $('#text-edit-form').addEventListener('change', () => updatePendingReplacement());
  document.addEventListener('pointerdown', (event) => {
    if (!pendingReplacement || !inlineTextEditor) return;
    if (inlineTextEditor.contains(event.target) || $('#text-edit-panel').contains(event.target)) return;
    if (event.target.closest?.('.zoom-controls')) return;
    applyTextReplacement();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingReplacement && inlineTextEditor) {
      event.preventDefault();
      cancelPendingReplacement();
    }
  });
  $('#add-signature').addEventListener('click', () => { if (markupMode) toggleMarkupMode(false); inputImage.dataset.signature = 'true'; inputImage.click(); });
  $('#add-image').addEventListener('click', () => { if (markupMode) toggleMarkupMode(false); inputImage.dataset.signature = 'false'; inputImage.click(); });
  inputImage.addEventListener('change', () => handleImageFile(inputImage.files?.[0], inputImage.dataset.signature === 'true'));
  $('#draw-signature').addEventListener('click', () => { if (activePage()) $('#signature-dialog').showModal(); });
  $('#undo').addEventListener('click', () => restoreHistory(historyIndex - 1));
  $('#redo').addEventListener('click', () => restoreHistory(historyIndex + 1));
  $('#zoom').addEventListener('input', () => { zoom = Number($('#zoom').value) / 100; $('#zoom-value').value = `${Math.round(zoom * 100)}%`; $('#zoom-value').textContent = `${Math.round(zoom * 100)}%`; renderCurrentPage(); });
  $('#zoom-out').addEventListener('click', () => { zoom = Math.max(.35, zoom - .1); $('#zoom').value = String(Math.round(zoom * 100)); $('#zoom').dispatchEvent(new Event('input')); });
  $('#zoom-in').addEventListener('click', () => { zoom = Math.min(2, zoom + .1); $('#zoom').value = String(Math.round(zoom * 100)); $('#zoom').dispatchEvent(new Event('input')); });
  $('#fit-page').addEventListener('click', fitPage);
  layer.addEventListener('pointerdown', handleLayerPointerDown);
  layer.addEventListener('pointermove', handleLayerPointerMove);
  layer.addEventListener('pointerup', handleLayerPointerUp);
  layer.addEventListener('pointercancel', () => { drawingState = null; dragState = null; renderAnnotations(false); });
  textSelectionLayer.addEventListener('pointerdown', (event) => event.stopPropagation());
  stage.addEventListener('dragover', (event) => { event.preventDefault(); stage.classList.add('is-dragging'); });
  stage.addEventListener('dragleave', (event) => { if (!stage.contains(event.relatedTarget)) stage.classList.remove('is-dragging'); });
  stage.addEventListener('drop', (event) => { event.preventDefault(); stage.classList.remove('is-dragging'); const file = [...(event.dataTransfer?.files || [])].find((item) => item.type === 'application/pdf' || /\.pdf$/i.test(item.name)); openPdf(file); });
  document.addEventListener('keydown', (event) => {
    const command = event.metaKey || event.ctrlKey;
    const target = event.target;
    const editingField = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.classList?.contains('pdf-inline-text-editor');
    if (command && event.key.toLowerCase() === 'z' && !editingField) { event.preventDefault(); restoreHistory(event.shiftKey ? historyIndex + 1 : historyIndex - 1); }
    else if (command && event.key.toLowerCase() === 'y' && !editingField) { event.preventDefault(); restoreHistory(historyIndex + 1); }
    else if (event.key === 'Delete' && selectedAnnotation() && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) $('#delete-element')?.click();
    else if (event.key === 'Escape' && $('#signature-dialog').open) $('#signature-dialog').close();
  });

  setupSignaturePad();
  renderSignatureLibrary();
  $('#current-year').textContent = String(new Date().getFullYear());
  window.addEventListener('beforeunload', clearDocument, { once: true });
})();
