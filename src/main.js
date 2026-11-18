import { createBackend } from './backend.js';

const assets = {
  QRCodeVendor: ['qr-code.js', () => typeof window.makeQrSvg === 'function'],
  QRReader: ['qr-reader.js', () => typeof window.jsQR === 'function'],
  ImportXlsx: ['import-xlsx.js', () => typeof window.readStudentWorkbook === 'function']
};
const pending = new Map();
window.loadRotasAsset = name => {
  const asset = assets[name];
  if (!asset) return Promise.reject(Error('Recurso indisponível.'));
  if (asset[1]()) return Promise.resolve();
  if (pending.has(name)) return pending.get(name);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${import.meta.env.BASE_URL}vendor/${asset[0]}`;
    script.onload = () => asset[1]() ? resolve() : reject(Error('Não foi possível iniciar este recurso.'));
    script.onerror = () => { script.remove(); pending.delete(name); reject(Error('Não foi possível carregar este recurso. Tente novamente.')); };
    document.head.append(script);
  });
  pending.set(name, task);
  return task;
};

const toggle = document.getElementById('contrastToggle');
let contrast = false;
try { contrast = localStorage.getItem('rc_contrast') === 'high'; } catch {}
function updateContrast() { document.documentElement.classList.toggle('high-contrast', contrast); toggle.setAttribute('aria-pressed', String(contrast)); }
toggle.addEventListener('click', () => { contrast = !contrast; updateContrast(); try { localStorage.setItem('rc_contrast', contrast ? 'high' : 'normal'); } catch {} });
updateContrast();
document.getElementById('rotasStartupRetry').addEventListener('click', () => window.location.reload());

try {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || /SEU-PROJETO|SUA_CHAVE/.test(url + key)) throw Error('A conexão do sistema ainda precisa ser configurada pela administração.');
  window.rotasBackend = await createBackend(url, key);
  await import('./client.js');
} catch (error) {
  document.getElementById('rotasStartupStatus').textContent = error.message || 'Não foi possível abrir o sistema. Tente novamente.';
  document.getElementById('rotasStartupRetry').hidden = false;
}
