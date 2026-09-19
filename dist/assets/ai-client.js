/* Cliente unificado de IA. Las claves se mantienen sólo en memoria. */
window.SuiteAI = (() => {
  const SESSION_CONFIG_KEY = 'suite-ai-config-v1';
  const LOCAL_CONFIG_KEY = 'suite-ai-config-persistent-v1';

  function normalizeKey(raw = '') {
    return String(raw)
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|DASHSCOPE_API_KEY|POLLINATIONS_API_KEY|HF_TOKEN|HUGGING_FACE_TOKEN)\s*=\s*/i, '')
      .replace(/^Bearer\s+/i, '')
      .replace(/\s+/g, '');
  }

  async function readJson(response) {
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch (_) { data = { message:text || 'Respuesta no válida del proveedor.' }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || data?.error_description || `Error HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function friendlyError(error, provider = '') {
    const raw = String(error?.message || error || 'Error desconocido');
    if (provider === 'huggingface' && /insufficient permissions|make calls to inference providers|does not have sufficient permissions/i.test(raw)) {
      return 'El token es auténtico, pero no tiene permiso para usar Inference Providers. En Hugging Face crea o edita un token fine-grained y habilita “Make calls to Inference Providers”; después vuelve a probar la generación.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(raw)) {
      return 'El navegador no pudo conectarse con la API. No significa necesariamente que la clave sea incorrecta: abre la suite mediante un servidor local y revisa las restricciones de origen/CORS de la clave.';
    }
    if (/api key not valid|invalid.*key|key.*invalid|invalid authentication credentials/i.test(raw) && provider !== 'huggingface') {
      return 'La API rechazó la credencial. Comprueba que sea una clave creada en Google AI Studio para Gemini API, sin comillas ni prefijos, y que el proyecto tenga la API habilitada.';
    }
    if (error?.status === 400) return `${provider ? `${provider}: ` : ''}La solicitud no fue aceptada por la API: ${raw}`;
    if (error?.status === 401) return 'La credencial no fue autorizada por el proveedor. Verifica la clave y el tipo de cuenta.';
    if (error?.status === 402) return 'La clave fue aceptada, pero el proveedor informa que no tiene saldo o presupuesto disponible.';
    if (error?.status === 403) return provider === 'huggingface' ? 'Hugging Face rechazó el acceso. Comprueba el permiso “Make calls to Inference Providers” y, si corresponde, acepta las condiciones del modelo FLUX.1-schnell.' : 'La clave existe, pero está bloqueada o sus restricciones no permiten esta solicitud. Revisa la clave y el proyecto en la consola del proveedor.';
    if (error?.status === 429) return 'La clave fue aceptada, pero no tiene cuota disponible o alcanzó el límite de solicitudes.';
    if (error?.status >= 500) return 'El servicio de IA no está disponible temporalmente. Intenta nuevamente en unos minutos.';
    return `${provider ? `${provider}: ` : ''}${raw}`;
  }

  function loadConfig() {
    try {
      const raw = sessionStorage.getItem(SESSION_CONFIG_KEY) || localStorage.getItem(LOCAL_CONFIG_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return saved?.provider && saved?.key ? saved : null;
    } catch (_) { return null; }
  }

  function saveConfig(config, remember = false) {
    const saved = {
      provider:String(config?.provider || 'gemini'),
      key:normalizeKey(config?.key),
      endpoint:String(config?.endpoint || '').trim()
    };
    if (!saved.key) throw new Error('Ingresa una clave API.');
    sessionStorage.setItem(SESSION_CONFIG_KEY, JSON.stringify(saved));
    if (remember) localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(saved));
    else localStorage.removeItem(LOCAL_CONFIG_KEY);
    return saved;
  }

  function clearConfig() {
    sessionStorage.removeItem(SESSION_CONFIG_KEY);
    localStorage.removeItem(LOCAL_CONFIG_KEY);
  }

  function fillConfigFields(providerElement, keyElement, endpointElement) {
    const saved = loadConfig();
    if (!saved) return null;
    if (providerElement) providerElement.value = saved.provider;
    if (keyElement) keyElement.value = saved.key;
    if (endpointElement) endpointElement.value = saved.endpoint || '';
    return saved;
  }

  function deepText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value.output_text) return value.output_text;
    if (value.text) return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value)) {
      for (const item of value) { const found = deepText(item); if (found) return found; }
    }
    if (typeof value === 'object') {
      for (const key of ['steps','outputs','output','candidates','choices','message','content','parts']) {
        const found = deepText(value[key]); if (found) return found;
      }
    }
    return '';
  }

  // La API REST de Interactions no incluye la propiedad auxiliar `output_text`
  // de los SDK. El texto real llega dentro de steps[].content[].text.
  function interactionText(data) {
    const chunks = [];
    for (const step of data?.steps || []) {
      if (step?.type !== 'model_output') continue;
      for (const part of step.content || []) {
        if (part?.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
      }
    }
    return chunks.join('').trim();
  }

  async function geminiGenerateContent(key, prompt) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
      method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})
    });
    const data = await readJson(response);
    const text = deepText(data);
    if (!text) throw new Error('Gemini respondió correctamente, pero no incluyó contenido de texto.');
    return text.trim();
  }

  function deepImage(value) {
    if (!value) return null;
    if (typeof value === 'string' && (value.startsWith('data:image') || value.startsWith('http'))) return value;
    if (typeof value !== 'object') return null;
    if (value.b64_json) return `data:image/png;base64,${value.b64_json}`;
    if (value.type === 'image' && typeof value.data === 'string') return `data:${value.mime_type || value.mimeType || 'image/png'};base64,${value.data}`;
    if (value.output_image?.data) return `data:${value.output_image.mime_type || value.output_image.mimeType || 'image/png'};base64,${value.output_image.data}`;
    if (value.inlineData?.data) return `data:${value.inlineData.mimeType || 'image/png'};base64,${value.inlineData.data}`;
    if (value.inline_data?.data) return `data:${value.inline_data.mime_type || 'image/png'};base64,${value.inline_data.data}`;
    if (value.image && typeof value.image === 'string') return value.image;
    if (value.url && /^https?:/i.test(value.url)) return value.url;
    for (const item of Object.values(value)) { const found = deepImage(item); if (found) return found; }
    return null;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen generada.'));
      reader.readAsDataURL(blob);
    });
  }

  // El cliente oficial se carga sólo cuando se utiliza Hugging Face, para no
  // añadir peso ni dependencias a las demás aplicaciones de la suite.
  let huggingFaceModule;
  async function huggingFaceClient(key) {
    huggingFaceModule ||= import('https://esm.sh/@huggingface/inference');
    const { InferenceClient } = await huggingFaceModule;
    return new InferenceClient(key);
  }

  async function geminiInteractionText(key, prompt, model) {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify({model,store:false,input:prompt})
      });
      const data = await readJson(response);
      const text = interactionText(data) || deepText(data);
      if (!text) throw new Error('Gemini respondió sin texto.');
      return text.trim();
  }

  async function geminiText(key, prompt) {
    // Gemini 2.5 ya no está disponible para cuentas nuevas. Usamos el modelo
    // estable recomendado por Google y, ante 429, probamos Flash-Lite 3.5.
    try {
      return await geminiInteractionText(key, prompt, 'gemini-3.6-flash');
    } catch (error) {
      if (error?.status === 429) {
        try { return await geminiInteractionText(key, prompt, 'gemini-3.5-flash-lite'); }
        catch (fallbackError) { throw fallbackError; }
      }
      const noText = /sin texto|no incluyó contenido/i.test(String(error?.message || ''));
      const endpointUnavailable = [400, 404].includes(error?.status) &&
        !/api key|credential|permission|blocked|quota/i.test(String(error?.message || ''));
      if (!noText && !endpointUnavailable) throw error;
      return geminiGenerateContent(key, prompt);
    }
  }

  async function callText({ provider, key:rawKey, endpoint = '', prompt }) {
    const key = normalizeKey(rawKey);
    if (!key) throw new Error('Ingresa una clave API.');
    try {
      if (provider === 'gemini') return await geminiText(key, prompt);
      if (provider === 'pollinations') {
        const response = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
          body:JSON.stringify({model:'openai',messages:[{role:'user',content:prompt}]})
        });
        const data = await readJson(response); const text = deepText(data);
        if (!text) throw new Error('Pollinations respondió sin texto.');
        return text.trim();
      }
      if (provider === 'openai') {
        const response = await fetch('https://api.openai.com/v1/responses', {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'gpt-5-mini',input:prompt})});
        const data = await readJson(response); const text = deepText(data);
        if (!text) throw new Error('OpenAI respondió sin texto.'); return text.trim();
      }
      if (!endpoint.trim()) throw new Error('Ingresa el endpoint compatible de Qwen.');
      const response = await fetch(endpoint.trim(), {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'qwen-plus',messages:[{role:'user',content:prompt}]})});
      const data = await readJson(response); const text = deepText(data);
      if (!text) throw new Error('Qwen respondió sin texto.'); return text.trim();
    } catch (error) { throw new Error(friendlyError(error, provider)); }
  }

  async function generateImage({ provider, key:rawKey, endpoint = '', prompt }) {
    const key = normalizeKey(rawKey);
    if (!key) throw new Error('Ingresa una clave API.');
    try {
      let response;
      if (provider === 'huggingface') {
        const client = await huggingFaceClient(key);
        const image = await client.textToImage({
          model:'black-forest-labs/FLUX.1-schnell',
          inputs:prompt,
          parameters:{width:768,height:1344,num_inference_steps:4}
        });
        if (!(image instanceof Blob) || !image.type.startsWith('image/')) throw new Error('Hugging Face no devolvió una imagen válida.');
        return await blobToDataUrl(image);
      }
      if (provider === 'openai') response = await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'gpt-image-2',prompt,size:'1024x1792',quality:'medium',output_format:'jpeg'})});
      else if (provider === 'pollinations') {
        const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=768&height=1344`;
        response = await fetch(url, {headers:{'Authorization':`Bearer ${key}`}});
        if (!response.ok) await readJson(response);
        return await blobToDataUrl(await response.blob());
      }
      else if (provider === 'gemini') response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        body:JSON.stringify({
          model:'gemini-3.1-flash-image',
          store:false,
          input:[{type:'text',text:prompt}],
          response_format:{type:'image',mime_type:'image/jpeg',aspect_ratio:'9:16',image_size:'1K'}
        })
      });
      else {
        if (!endpoint.trim()) throw new Error('Ingresa el endpoint de tu workspace de Qwen.');
        response = await fetch(endpoint.trim(),{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'qwen-image-3.0',input:{messages:[{role:'user',content:[{text:prompt}]}]},parameters:{size:'768*1344',n:1}})});
      }
      const data = await readJson(response); const image = deepImage(data);
      if (!image) throw new Error('La API respondió sin una imagen descargable.');
      return image;
    } catch (error) {
      if (provider === 'gemini' && error?.status === 429) {
        throw new Error('La clave es válida, pero Google devolvió cuota insuficiente para el modelo de imágenes. Gemini permite probar imágenes en AI Studio, pero su API de generación de imágenes no está disponible en el nivel gratuito. Activa la facturación del proyecto asociado a esta clave. Si ya está activa, revisa que el proyecto figure en un nivel de pago y que aún tenga saldo o límite disponible.');
      }
      throw new Error(friendlyError(error, provider));
    }
  }

  async function validate({provider,key,endpoint}) {
    if (provider === 'huggingface') {
      const normalized = normalizeKey(key);
      if (!normalized) throw new Error('Ingresa un token de Hugging Face.');
      try {
        const response = await fetch('https://huggingface.co/api/whoami-v2', {headers:{'Authorization':`Bearer ${normalized}`}});
        await readJson(response);
        return true;
      } catch (error) { throw new Error(friendlyError(error, 'Hugging Face')); }
    }
    if (provider === 'pollinations') {
      const normalized = normalizeKey(key);
      if (!normalized) throw new Error('Ingresa una clave API.');
      try {
        const response = await fetch('https://gen.pollinations.ai/account/key', {headers:{'Authorization':`Bearer ${normalized}`}});
        await readJson(response);
        return true;
      } catch (error) { throw new Error(friendlyError(error, 'Pollinations')); }
    }
    const text = await callText({provider,key,endpoint,prompt:'Responde únicamente con la palabra OK.'});
    return Boolean(text);
  }

  return { normalizeKey, friendlyError, callText, generateImage, validate, loadConfig, saveConfig, clearConfig, fillConfigFields, extractText:deepText, extractInteractionText:interactionText };
})();
