/* Utilidades compartidas por las subaplicaciones. Sin dependencias externas. */
window.SuiteUtils = (() => {
  const enc = new TextEncoder();

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  }

  function formatDate(value) {
    if (!value) return 'A confirmar';
    const date = new Date(`${value}T12:00:00`);
    return new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'short', year:'numeric' }).format(date);
  }

  function money(value, currency = 'USD', fractionDigits = currency === 'ARS' ? 0 : 2) {
    const number = Number(value || 0);
    return new Intl.NumberFormat('es-AR', { style:'currency', currency, minimumFractionDigits:fractionDigits, maximumFractionDigits:fractionDigits }).format(number);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function drawCover(ctx, image, x, y, width, height) {
    const scale = Math.max(width / image.width, height / image.height);
    const sw = width / scale;
    const sh = height / scale;
    const sx = (image.width - sw) / 2;
    const sy = (image.height - sh) / 2;
    ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    });
    if (line) lines.push(line);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.,;:]?$/, '')}…`;
    visible.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
    return y + visible.length * lineHeight;
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
  }

  function triggerDownload(url, filename, revoke = false) {
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    // Safari puede ignorar MouseEvent construidos manualmente por no ser
    // eventos confiables. click() invoca el comportamiento nativo del enlace.
    link.click();
    // El enlace y el Blob deben seguir vivos mientras comienza la transferencia.
    setTimeout(() => link.remove(), 2000);
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function downloadCanvas(canvas, filename, type = 'image/jpeg', quality = .94) {
    // Blob URL evita los límites de tamaño de las data URL en Safari.
    const dataUrl = canvas.toDataURL(type, quality);
    const blob = new Blob([dataUrlBytes(dataUrl)], { type });
    triggerDownload(URL.createObjectURL(blob), filename, true);
  }

  function dataUrlBytes(dataUrl) {
    const binary = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    parts.forEach((part) => { result.set(part, offset); offset += part.length; });
    return result;
  }

  // Crea PDFs A4 reales, de una o varias páginas, usando canvases como páginas.
  function canvasesToPdf(canvases, filename) {
    const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', null];
    const pageIds = [];
    canvases.forEach((canvas, index) => {
      const jpeg = dataUrlBytes(canvas.toDataURL('image/jpeg', .94));
      const portrait = canvas.height >= canvas.width;
      const pageWidth = portrait ? 595.28 : 841.89;
      const pageHeight = portrait ? 841.89 : 595.28;
      const pageId = 3 + index * 3;
      const contentId = pageId + 1;
      const imageId = pageId + 2;
      const imageName = `Im${index}`;
      const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/${imageName} Do\nQ`;
      pageIds.push(`${pageId} 0 R`);
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`;
      objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      objects[imageId] = { image:true, bytes:jpeg, head:`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n` };
    });
    objects[2] = `<< /Type /Pages /Kids [${pageIds.join(' ')}] /Count ${canvases.length} >>`;
    const parts = [enc.encode('%PDF-1.4\n%âãÏÓ\n')];
    const offsets = [0];
    let total = parts[0].length;
    for (let i = 1; i < objects.length; i += 1) {
      offsets[i] = total;
      const start = enc.encode(`${i} 0 obj\n`);
      const body = objects[i].image
        ? concat([enc.encode(objects[i].head), objects[i].bytes, enc.encode('\nendstream')])
        : enc.encode(objects[i]);
      const end = enc.encode('\nendobj\n');
      parts.push(start, body, end);
      total += start.length + body.length + end.length;
    }
    const xrefOffset = total;
    let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i += 1) xref += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    parts.push(enc.encode(xref));
    const blob = new Blob([concat(parts)], { type:'application/pdf' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename, true);
  }

  function canvasToPdf(canvas, filename) { canvasesToPdf([canvas], filename); }

  function setStatus(element, message, type = 'info') {
    element.className = `status status--${type} is-visible`;
    element.textContent = message;
  }

  return { escapeHtml, formatDate, money, loadImage, drawCover, wrapText, roundedRect, triggerDownload, downloadCanvas, canvasToPdf, canvasesToPdf, setStatus };
})();
