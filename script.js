/*
 * ROTAS CARBONITA — versão para publicação estática.
 * Edite a configuração abaixo usando os mesmos valores do config.js anterior.
 * Use apenas a Project URL e a chave PÚBLICA publishable/anon do Supabase.
 * O banco, as permissões e a Edge Function permanecem no Supabase.
 */
const ROTAS_CONFIG = Object.freeze({
  supabaseUrl: "https://nopuzcrkrserlppxhcop.supabase.co",
  supabasePublishableKey: "sb_publishable_D2p0OxJxt9UhT4E1WLYWpg_vbCHqdEr"
});

(function () {
'use strict';

// ============================================================================
// 1. CONEXÃO, AUTENTICAÇÃO E OPERAÇÕES DO SUPABASE
// ============================================================================
function createClient(...args) {
  if(typeof window.RotasSupabase?.createClient!=='function'){
    throw Error('Não foi possível carregar a conexão do sistema. Verifique a internet e tente novamente.');
  }
  return window.RotasSupabase.createClient(...args);
}

function loginEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /@acesso\.rotas\.invalid$/.test(value)) {
    throw Error('Informe seu e-mail válido cadastrado para acessar o sistema.');
  }
  return value;
}

async function createBackend(url, publicKey) {
  const client = createClient(url, publicKey, {
    auth: { storage: window.sessionStorage, storageKey: 'rotas_auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  let { data: { session } } = await client.auth.getSession();
  const emailSession = candidate => {
    try { return Boolean(candidate && loginEmail(candidate.user?.email)); } catch { return false; }
  };
  if (session && !emailSession(session)) {
    await client.auth.signOut({ scope: 'local' });
    session = null;
  }
  let channel;
  const emit = name => window.dispatchEvent(new Event(name));
  const errorMessage = error => {
    if (/Invalid login credentials/i.test(error?.message || '')) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(error?.message || '')) return 'Seu e-mail ainda não foi confirmado no Supabase. Confirme o cadastro para entrar.';
    if (/Failed to fetch|fetch failed|NetworkError/i.test(error?.message || '')) return 'Sem conexão com o sistema. Confira a internet e tente novamente.';
    if (/JWT expired|refresh token|not authenticated/i.test(error?.message || '')) return 'Sessão expirada. Entre novamente.';
    return error?.message || 'Não foi possível concluir. Tente novamente.';
  };
  async function rpc(action, payload = {}) {
    const { data, error } = await client.rpc('rotas_api', { action, payload }).abortSignal(AbortSignal.timeout(action === 'importStudents' ? 45000 : 20000));
    if (error) throw Object.assign(Error(errorMessage(error)), { code: error.code });
    return data;
  }
  async function watch() {
    if (channel) { await client.removeChannel(channel); channel = undefined; }
    if (!session) return;
    channel = client.channel('rotas-sync').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sync_state' }, () => emit('rotas:changed')).subscribe();
  }
  client.auth.onAuthStateChange((event, nextSession) => {
    if (nextSession && !emailSession(nextSession)) {
      session = null;
      setTimeout(() => client.auth.signOut({ scope: 'local' }).catch(() => {}), 0);
      emit('rotas:signed-out');
      return;
    }
    session = nextSession;
    if (event === 'SIGNED_OUT') emit('rotas:signed-out');
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(() => watch().catch(() => {}), 0);
  });
  async function manageUser(item) {
    const { data, error } = await client.rpc('rotas_manage_email_user', { item: { ...item, email: loginEmail(item.email) } }).abortSignal(AbortSignal.timeout(20000));
    if (error) {
      throw Error(errorMessage(error));
    }
    if (data?.error) throw Error(data.error);
    return data;
  }
  async function api(action, data = {}) {
    if (action === 'login') {
      const { data: signedIn, error } = await client.auth.signInWithPassword({ email: loginEmail(data.email), password: data.password });
      if (error) throw Error(errorMessage(error));
      if (!emailSession(signedIn.session)) {
        await client.auth.signOut({ scope: 'local' });
        throw Error('Entre com seu e-mail cadastrado. O acesso por usuário antigo foi encerrado.');
      }
      try { const user = await rpc('me'); await watch(); return { user }; }
      catch (error) {
        await client.auth.signOut({ scope: 'local' });
        if (/Sessão inválida|usuário inativo/i.test(error.message || '')) {
          throw Error('E-mail e senha confirmados. A Secretaria precisa vincular este e-mail a um perfil ativo de Secretaria, Escola ou Monitor.');
        }
        throw error;
      }
    }
    if (action === 'logout') {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw Error(errorMessage(error));
      return { success: true };
    }
    if (action === 'changePassword') {
      if (!data.current || !data.next || data.next.length < 12) throw Error('Informe a senha atual e uma nova senha de pelo menos 12 caracteres.');
      if (data.current === data.next) throw Error('A nova senha deve ser diferente da senha atual.');
      if (!emailSession(session)) throw Error('Sessão expirada. Entre novamente com seu e-mail.');
      const email = loginEmail(session.user.email);
      const checked = await client.auth.signInWithPassword({ email, password: data.current });
      if (checked.error) throw Error('Senha atual incorreta.');
      const updated = await client.auth.updateUser({ password: data.next });
      if (updated.error) throw Error(errorMessage(updated.error));
      return rpc('completePasswordChange');
    }
    if (action === 'createUser') return manageUser(data.item);
    if (action === 'setupMonitors') {
      const plan = await rpc('monitorSetupPreview', { year: data.year });
      let created = 0;
      for (const group of plan.groups) {
        for (const monitor of group.monitors.filter(m => !m.exists)) {
          await manageUser({ nome: monitor.nome, email: monitor.email, perfil: 'monitor' });
          created++;
        }
      }
      const result = await rpc(action, { year: data.year, routeIds: data.routeIds, schoolIds: data.schoolIds });
      result.counts.usersCreated = created;
      return result;
    }
    return rpc(action, data);
  }
  async function mapApi(action, payload, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const { data, error } = await client.rpc('rotas_map', { action, payload }).abortSignal(controller.signal);
      if (error) {
        if (error.code === 'PGRST202') throw Error('O armazenamento de percursos ainda não está disponível.');
        throw Error(errorMessage(error));
      }
      return data;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  await watch();
  return { api, mapApi, hasSession: () => Boolean(session) };
}


// ============================================================================
// 2. RECURSOS LOCAIS CARREGADOS POR FLUXO
// ============================================================================
const assetsBase=new URL('./assets/',document.currentScript.src);
const rotasAssets={
  QRCodeVendor:['qr-generator.js?v=1',()=>typeof window.makeQrSvg==='function'],
  QRReader:['qr-reader.js?v=1',()=>typeof window.jsQR==='function'],
  ImportXlsx:['xlsx-reader.js?v=1',()=>typeof window.readStudentWorkbook==='function'],
  MonitorDock:['monitor-dock.js?v=5']
};
const pendingAssets=new Map();
window.loadRotasAsset=name=>{
  const asset=rotasAssets[name];
  if(!asset)return Promise.reject(Error('Recurso indisponível.'));
  if(asset[1]?.())return Promise.resolve();
  if(pendingAssets.has(name))return pendingAssets.get(name);
  const task=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    const fail=()=>{
      script.remove();
      reject(Error('Não foi possível carregar este recurso. Verifique a conexão e tente novamente.'));
    };
    script.src=new URL(asset[0],assetsBase);
    script.onload=()=>asset[1]&&!asset[1]()?fail():resolve();
    script.onerror=fail;
    document.head.append(script);
  }).catch(error=>{pendingAssets.delete(name);throw error;});
  pendingAssets.set(name,task);
  return task;
};

// ============================================================================
// 3. INICIALIZAÇÃO
// ============================================================================
async function initializeRotas() {
  const toggle = document.getElementById('contrastToggle');
  let contrast = false;
  try { contrast = localStorage.getItem('rc_contrast') === 'high'; } catch {}
  function updateContrast() { document.documentElement.classList.toggle('high-contrast', contrast); toggle.setAttribute('aria-pressed', String(contrast)); }
  toggle.addEventListener('click', () => { contrast = !contrast; updateContrast(); try { localStorage.setItem('rc_contrast', contrast ? 'high' : 'normal'); } catch {} });
  updateContrast();
  document.getElementById('rotasStartupRetry').addEventListener('click', () => window.location.reload());
  const status = document.getElementById('rotasStartupStatus');
  const loadingTimer = setTimeout(() => { status.textContent = 'Carregando Rotas Carbonita…'; }, 300);
  try {
    const runtime = window.ROTAS_CONFIG || ROTAS_CONFIG;
    const url = String(runtime.supabaseUrl || '').trim();
    const key = String(runtime.supabasePublishableKey || '').trim();
    if (!url || !key || /SEU-PROJETO|SUA_CHAVE/.test(url + key)) throw Error('A conexão do sistema ainda precisa ser configurada pela administração.');
    window.rotasBackend = await createBackend(url, key);
    startRotasInterface();
  } catch (error) {
    status.textContent = error.message || 'Não foi possível abrir o sistema. Tente novamente.';
    document.getElementById('rotasStartupRetry').hidden = false;
  } finally {
    clearTimeout(loadingTimer);
  }
}

// ============================================================================
// 4. INTERFACE: TELAS, CADASTROS, CHAMADAS, CRACHÁS, IMPORTAÇÃO E RELATÓRIOS
// ============================================================================
function startRotasInterface() {
/* Rotas Carbonita — interface web. Dados carregados somente após autenticação. */
(function(){'use strict';
const STORE={get:k=>{try{return sessionStorage.getItem(k)||''}catch(e){return ''}},set:(k,v)=>{try{sessionStorage.setItem(k,v)}catch(e){}},remove:k=>{try{sessionStorage.removeItem(k)}catch(e){}}};
const S={token:window.rotasBackend.hasSession()?'authenticated':'',data:null,view:'',year:'',day:todayLocal(),sentido:'IDA',route:'',callSchool:'',callStop:'',filters:{search:'',school:'',route:'',stop:''},modal:null,busy:false,loading:false,loadingVisible:false,loadError:'',menu:false,checking:false};
const LABEL={profile:'Perfil',dashboard:'Visão geral',students:'Estudantes',schools:'Escolas',classes:'Turmas',routes:'Rotas',stops:'Pontos',routeMap:'Mapa de Rotas',attendance:'Chamada',users:'Acessos',reports:'Relatórios'};
const MONITOR_DOCK=[['dashboard','home'],['students','people'],['reports','chart'],['profile','person']];
const TYPE={student:'Estudante',school:'Escola',class:'Turma',route:'Rota',stop:'Ponto',user:'Usuário'};
const NAV=[['dashboard','home'],['students','people'],['schools','school'],['routes','route'],['stops','pin'],['routeMap','pin'],['attendance','checklist'],['reports','chart'],['users','lock']];
const $=id=>document.getElementById(id);
const E=x=>String(x===undefined||x===null?'':x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const a=(k)=>S.data?(S.data[k]||[]):[];
const find=(key,id)=>a(key).find(r=>r.id===id);
const val=(key,id,prop='nome')=>(find(key,id)||{})[prop]||'—';
const initials=n=>String(n||'').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const DIRECTION={IDA:'Para Escola',VOLTA:'Para Casa'};
const STUDENT_SHIFTS=[['MANHA','Manhã'],['TARDE','Tarde']];
const isActive=x=>x&&x.ativo!==false&&x.ativo!=='false'&&x.ativo!=='NAO';
let loadRequest=0;
const LOAD_FEEDBACK_DELAY=300;
function hasSnapshot(){
  return Boolean(S.data?.year!=null&&String(S.data.year)===String(S.year)&&S.data.day===S.day);
}
function todayLocal(){
  const parts=new Intl.DateTimeFormat('en',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const byType=Object.fromEntries(parts.map(({type,value})=>[type,value]));
  return byType.year+'-'+byType.month+'-'+byType.day;
}
function dateHuman(s){
  const parts=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(s??''));
  return parts?`${parts[3]}/${parts[2]}/${parts[1]}`:'—';
}
function timeHuman(s){
  const date=new Date(s);
  return s&&!isNaN(date.getTime())?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}).format(date):'';
}
function api(action,data={}){return window.rotasBackend.api(action,data);}
function message(text,isError=false){const wrap=$('toast');if(!wrap)return;const t=document.createElement('div');t.className='toast'+(isError?' error':'');t.textContent=text;wrap.append(t);setTimeout(()=>t.remove(),4500);}
function sessionEnded(msg){return /Sessão expirada|Sessão inválida|Usuário (?:desativado|inativo)|usuário inativo/i.test(msg);}
function warn(e){const msg=e&&e.message||String(e);message(msg,true);if(sessionEnded(msg)){stopCamera();++loadRequest;S.loading=false;S.loadingVisible=false;S.token='';S.data=null;S.modal=null;STORE.remove('rc_session');render();}}
async function load(showFeedback=false){
  if(!S.token)return;
  const token=S.token, request=++loadRequest;
  const context={year:S.year||undefined,day:S.day};
  const current=()=>S.token===token&&request===loadRequest;
  S.loadError='';
  S.loading=true;
  S.loadingVisible=false;
  if(!hasSnapshot()||S.view!==renderedView||document.querySelector('.snapshot-slot'))paintSnapshot();
  else updateLoadFeedback();
  const timer=setTimeout(()=>{
    if(!current())return;
    S.loadingVisible=true;
    if(!hasSnapshot())paintSnapshot();
    else if(showFeedback)updateLoadFeedback();
  },LOAD_FEEDBACK_DELAY);
  try{
    const d=await api('snapshot',context);
    if(!current())return;
    if(!d?.user)throw Error('O painel não recebeu os dados da sua conta.');
    const reveal=S.loadingVisible&&!hasSnapshot();
    S.loading=false;S.loadingVisible=false;
    return applySnapshot(d,reveal);
  }catch(e){
    if(!current())return;
    S.loading=false;S.loadingVisible=false;
    const msg=e&&e.message||String(e);
    if(/troca de senha/i.test(msg)){
      S.data=S.data||{user:{trocarSenha:'SIM',nome:'Usuário',perfil:'secretaria'}};
      S.modal={type:'password',mandatory:true};
      render();
      return;
    }
    if(sessionEnded(msg)){warn(e);return;}
    if(!hasSnapshot()){
      S.loadError=msg;
      paintSnapshot();
    }else{
      updateLoadFeedback();
      warn(e);
    }
  }finally{
    clearTimeout(timer);
  }
}
async function refresh(){
  if(!S.token||!hasSnapshot()||S.checking||S.busy||S.loading||S.modal||closingDialog||document.hidden)return;
  const {data,token,year,day}=S, request=loadRequest;
  const current=()=>request===loadRequest&&S.data===data&&S.token===token&&S.year===year&&S.day===day;
  S.checking=true;
  try{
    const x=await api('updates',{version:data.version,year,day});
    if(current()&&x.changed&&!S.modal&&!closingDialog&&!S.busy&&!S.loading)applySnapshot(x);
  }catch(e){
    if(current())warn(e);
  }finally{
    S.checking=false;
  }
}
setInterval(refresh,60000);
window.addEventListener('rotas:changed',refresh);
window.addEventListener('rotas:signed-out',()=>{if(S.token)logout();});
function user(){return S.data&&S.data.user||null;}
function role(){return user()&&user().perfil||'';}
function canEdit(){return role()==='secretaria'||role()==='escola';}
function routeSchoolIds(route){return route?.escolaIds||[];}
function routeSchools(route){return a('schools').filter(school=>routeSchoolIds(route).includes(school.id));}
function routeSchoolNames(route){return routeSchools(route).map(school=>school.nome).join(' · ');}
function canManageStudent(student){
  return canEdit()||role()==='monitor'&&(student
    ? isActive(student)&&(student.cadastroPendenteProprio===true&&!student.rotaId
      ||Boolean(find('routes',student.rotaId))&&(!student.pontoId||find('stops',student.pontoId)?.rotaId===student.rotaId))
    : a('routes').some(isActive));
}
function canEditRoute(route){return Boolean(route&&(role()==='secretaria'||(role()==='escola'&&!route.compartilhada)));}
function canSee(name){if(name==='profile')return role()==='monitor';if(name==='routeMap')return ['secretaria','escola','monitor'].includes(role());if(name==='users'||name==='schools')return role()==='secretaria';if(role()==='monitor')return ['dashboard','students','attendance','reports'].includes(name);return true;}
let routeMapRoot, routeMapInstance, routeMapWorkspace, routeMapContext;
function disposeRouteMap(){
  routeMapInstance?.destroy();
  routeMapInstance=undefined;
  routeMapRoot=undefined;
}
function routeMapData(){
  const schools=a('schools').filter(isActive).filter(school=>role()!=='escola'||school.id===user()?.escolaId)
    .map(school=>({id:school.id,name:school.nome}));
  const schoolIds=new Set(schools.map(school=>school.id));
  const routes=a('routes').filter(isActive).map(route=>({
    id:route.id,name:route.nome,schoolIds:routeSchoolIds(route).filter(id=>schoolIds.has(id)),
  })).filter(route=>role()!=='escola'||route.schoolIds.length);
  const allowed=new Set(routes.map(route=>route.id));
  const stops=a('stops').filter(stop=>allowed.has(stop.rotaId)&&isActive(stop))
    .map(stop=>({id:stop.id,name:stop.nome,routeId:stop.rotaId}));
  return {role:role(),routes,schools:schools.filter(school=>routes.some(route=>route.schoolIds.includes(school.id))),stops};
}
function syncRouteMap(){
  const context=S.token&&S.data?JSON.stringify([user()?.id,user()?.perfil,user()?.escolaId,S.year]):'';
  if(routeMapContext!==context){
    disposeRouteMap();
    routeMapContext=context;
    routeMapWorkspace=undefined;
  }
  const root=$('routeMap');
  if(!root||!hasSnapshot()||!canSee('routeMap')){disposeRouteMap();return;}
  if(root===routeMapRoot){routeMapInstance?.update(routeMapData());return;}
  disposeRouteMap();
  routeMapRoot=root;
  const mount=async()=>{
    const status=root.querySelector('p');
    const retry=root.querySelector('button');
    retry.hidden=true;
    status.textContent='Carregando mapa…';
    try{
      const module=await import(new URL('route-map.mjs?v=8',assetsBase).href);
      if(routeMapRoot!==root||!root.isConnected)return;
      routeMapWorkspace??=module.createWorkspace();
      routeMapInstance=module.mountRouteMap(root,routeMapData(),routeMapWorkspace,{
        gateway:(action, payload, signal)=>window.rotasBackend.mapApi(action,{...payload,year:S.year},signal),
        institutionalEndpoint:(window.ROTAS_CONFIG||ROTAS_CONFIG).routeMapOsrmUrl
      });
    }catch{
      if(routeMapRoot!==root||!root.isConnected)return;
      status.textContent='Não foi possível abrir o mapa.';
      retry.hidden=false;
    }
  };
  root.querySelector('button').addEventListener('click',mount);
  void mount();
}
function routeMapScreen(){
  return '<header class="rm-heading"><h1>Mapa de Rotas</h1><button class="btn small" type="button" data-act="print" aria-label="Imprimir mapa" title="Imprimir mapa">'+icon('print')+' <span>Imprimir</span></button></header>'+
    '<div id="routeMap"><p role="status">Carregando mapa…</p><button class="btn" type="button" hidden>Tentar novamente</button></div>';
}
let renderedView='', renderedModalType='', renderedMenu=false, closingDialog=false;
let renderedDisclosureContext='', renderedDisclosureModal=null;
function disclosureContext(){return JSON.stringify([role(),S.view,S.year,S.day]);}
function disclosureStates(root){
  return new Map([...(root?.querySelectorAll?.('details[data-disclosure]')||[])]
    .map(detail=>[detail.dataset.disclosure,detail.open]));
}
function syncDisclosure(detail){
  const body=detail.lastElementChild;
  if(!detail.open&&body.contains(document.activeElement))detail.firstElementChild.focus({preventScroll:true});
  body.inert=!detail.open;
}
function restoreDisclosures(root,states){
  for(const detail of root?.querySelectorAll('details[data-disclosure]')||[]){
    const key=detail.dataset.disclosure;
    if(states.has(key))detail.open=states.get(key);
    syncDisclosure(detail);
  }
}
function focusDisclosure(root,key){
  const detail=[...root.querySelectorAll('details[data-disclosure]')].find(item=>item.dataset.disclosure===key);
  detail?.firstElementChild.focus({preventScroll:true});
}
function disclosure(key,label,body,{open=false,className='',id=''}={}){
  return `<details class="disclosure ${className}" data-disclosure="${E(key)}" ${id?`id="${E(id)}"`:''} ${open?'open':''}>
    <summary><span class="disclosure-label">${label}</span></summary>
    <div class="disclosure-body" ${open?'':'inert'}><div class="disclosure-inner">${body}</div></div>
  </details>`;
}
document.addEventListener('toggle',event=>{
  if(event.target.matches?.('details[data-disclosure]'))syncDisclosure(event.target);
},true);
document.addEventListener('click',event=>{
  const detail=event.target.closest?.('.disclosure > summary')?.parentElement;
  // Prevent focus from entering a collapsing panel before the native toggle event.
  if(detail?.open&&!event.defaultPrevented){
    if(detail.lastElementChild.contains(document.activeElement))detail.firstElementChild.focus({preventScroll:true});
    detail.lastElementChild.inert=true;
  }
});
function render(){
  if(closingDialog&&S.token)return;
  disposeRouteMap();
  if(!S.token){routeMapWorkspace=undefined;routeMapContext=undefined;}
  const app=$('app');
  const reactDock=$('monitorDockReact');
  const fallbackDock=$('monitorDockFallback');
  if(S.token&&(user()?.trocarSenha==='SIM'||user()?.exigeTroca))S.modal={type:'password',mandatory:true};
  const modalType=S.modal?.type||'';
  const openingDialog=Boolean(modalType&&modalType!==renderedModalType);
  renderedModalType=modalType;
  const previousModal = openingDialog ? null : app.querySelector('.modal');
  const modalScroll = previousModal?.scrollTop ?? 0;
  const dialogOpen=S.modal?'inert':'';
  $('siteHeader')?.toggleAttribute('inert',Boolean(S.modal));
  $('siteFooter')?.toggleAttribute('inert',Boolean(S.modal));

  const showDock=Boolean(S.token&&S.data&&role()==='monitor'&&!(S.modal?.type==='password'&&!S.data.schools));
  for(const dock of [reactDock,fallbackDock]){
    dock.hidden=!showDock;
    dock.toggleAttribute('inert',Boolean(S.modal));
  }
  if(!S.token){S.view='';renderedView='';renderedMenu=false;renderedDisclosureContext='';renderedDisclosureModal=null;app.innerHTML=loginHtml();return;}
  if(S.modal&&S.modal.type==='password'&&(!S.data||!S.data.schools)){
    app.innerHTML=`<main class="splash${openingDialog?' dialog-enter':''}" id="conteudo" tabindex="-1">${modalHtml()}</main>`;
    $('modalTitle')?.focus();
    return;
  }
  if(!S.data){
    app.innerHTML=`<main class="snapshot-startup" id="conteudo" tabindex="-1">${snapshotPlaceholder()}</main>`;
    return;
  }
  const monitor=role()==='monitor';
  if(!S.view||!canSee(S.view)){
    S.view=monitor?'attendance':'dashboard';
  }
  if(monitor){
    syncMonitorDock(reactDock,fallbackDock);
    if(showDock)prepareMonitorAssets();
  }
  const previousMain=app.querySelector('.main');
  const context=disclosureContext();
  const panelStates=disclosureStates(context===renderedDisclosureContext?previousMain:null);
  const modalStates=disclosureStates(S.modal&&S.modal.type!=='scanner'&&S.modal===renderedDisclosureModal?previousModal:null);
  renderedDisclosureContext=context;
  renderedDisclosureModal=S.modal;
  const active=document.activeElement;
  const mainFocused=previousMain&&previousMain===active;
  const focusedId=app.contains(active)?active.id:'';
  const focusedSummary=active.matches?.('.disclosure > summary')?active.parentElement.dataset.disclosure:'';
  const sameView=S.view===renderedView;
  const mainScroll=sameView?previousMain?.scrollTop??0:0;
  const enteringView=hasSnapshot()&&S.view!==renderedView;
  const openingMenu=S.menu&&!renderedMenu;
  renderedView=S.view;
  renderedMenu=S.menu;
  const cardLists=[];
  app.innerHTML=`<div class="shell${monitor?' monitor-shell':' admin-shell'}${S.menu?' menu-open':''}${openingMenu?' menu-enter':''}${openingDialog?' dialog-enter':''}">
    <div class="topbar" ${dialogOpen}>
      <div class="topbar-context">
        <button id="portalMenu" class="icon-btn mobile-menu" type="button" data-act="menu" aria-label="Menu de navegação" aria-controls="portalNav" aria-expanded="${S.menu}">${icon('menu')}</button>
        ${monitor&&S.view!=='attendance'?'<button type="button" class="btn monitor-call-shortcut" data-act="todayCalls">'+icon('checklist')+' Chamada</button>':''}
        <div class="crumb"><span class="crumb-prefix">Transporte escolar ${icon('chevron')}</span><strong>${E(LABEL[S.view])}</strong></div>
      </div>
      <div class="topright">
        <select class="control" id="yearSelect" aria-label="Ano letivo">${yearOptions()}</select>
        <button class="icon-btn" type="button" data-act="refresh" aria-label="Atualizar dados" title="Atualizar dados">${icon('refresh')}</button>
        <span id="snapshotStatus" class="sr-only" role="status"></span>
        <button class="icon-btn" type="button" data-act="password" aria-label="Alterar senha" title="Alterar senha">${icon('lock')}</button>
      </div>
    </div>
    <aside class="sidebar" id="portalNav" ${dialogOpen}>
      ${portalNavigation(monitor)}
      <div class="account">
        <div class="avatar" aria-hidden="true">${E(initials(user().nome))}</div>
        <div class="account-main"><strong>${E(user().nome)}</strong><span>${E({secretaria:'Secretaria Municipal',escola:'Unidade escolar',monitor:'Monitor de transporte'}[role()])}</span></div>
        <button class="btn danger account-logout" type="button" data-act="logout">${icon('logout')} Sair</button>
      </div>
    </aside>
    <main class="main" id="conteudo" tabindex="-1" ${dialogOpen}>
      <div class="content${enteringView?' view-enter':''}">${snapshotContent(cardLists)}</div>
    </main>
    ${S.modal?modalHtml():''}
  </div>`;
  const main=$('conteudo');
  mountStudentCards(main,cardLists);
  restoreDisclosures(main,panelStates);
  restoreDisclosures(app.querySelector('.modal'),modalStates);
  main.scrollTop=mainScroll;
  if(!S.modal&&sameView){
    if(mainFocused)main.focus({preventScroll:true});
    else if(focusedId)$(focusedId)?.focus({preventScroll:true});
    else if(focusedSummary)focusDisclosure(main,focusedSummary);
  }
  updateLoadFeedback();
  observeReportTables();
  syncRouteMap();
  if (S.modal) {
    app.querySelector('.modal').scrollTop = modalScroll;
    if (openingDialog) $('modalTitle')?.focus({preventScroll:true});
    else if(focusedSummary&&modalStates.has(focusedSummary))focusDisclosure(app.querySelector('.modal'),focusedSummary);
  }
  if(S.modal?.type==='assign')syncAssignmentForm($('modalForm'));
  if(S.modal?.mandatory)$('modalTitle')?.focus();
}
const mobileMonitorDock=window.matchMedia('(max-width: 870px)');
let monitorQrPreload;
let monitorDockScheduled=false;
function prepareMonitorAssets(){
  const host=$('monitorDockReact');
  if(host.hidden||document.hidden)return;
  const connection=navigator.connection;
  if(!monitorQrPreload&&!connection?.saveData&&!['slow-2g','2g'].includes(connection?.effectiveType)){
    monitorQrPreload=window.loadRotasAsset('QRReader').catch(()=>{});
  }
  if(!mobileMonitorDock.matches||monitorDockScheduled||pendingAssets.has('MonitorDock'))return;
  monitorDockScheduled=true;
  const prepare=()=>{
    monitorDockScheduled=false;
    if(!host.hidden&&mobileMonitorDock.matches)window.loadRotasAsset('MonitorDock').catch(()=>{});
  };
  Promise.resolve(monitorQrPreload).then(()=>{
    if(window.requestIdleCallback)window.requestIdleCallback(prepare,{timeout:600});
    else requestAnimationFrame(prepare);
  });
}
mobileMonitorDock.addEventListener('change',prepareMonitorAssets);
function portalNavigation(monitor){
  const items=NAV.filter(([view])=>canSee(view));
  const buttons=items=>`${items.map(([v,ico])=>`<button type="button" class="nav-btn" ${S.view===v?'aria-current="page"':''} data-act="nav" data-view="${v}">${icon(ico)}${LABEL[v]}</button>`).join('')}`;
  if(monitor)return `<div class="nav-group">Gestão do transporte</div><nav class="nav-items" aria-label="Menu principal">${buttons(items)}</nav>`;
  const section=(title,views)=>`<div class="nav-section" role="group" aria-label="${title}"><div class="nav-group" aria-hidden="true">${title}</div><div class="nav-items">${buttons(views)}</div></div>`;
  return `<nav aria-label="Menu principal">
    ${section('Cadastros',items.filter(([view])=>!['attendance','reports','users'].includes(view)))}
    ${section('Acompanhamento',items.filter(([view])=>['attendance','reports'].includes(view)))}
    ${items.some(([view])=>view==='users')?section('Administração',items.filter(([view])=>view==='users')):''}
  </nav>`;
}
function visibleMonitorDock(){
  return [...document.querySelectorAll('#monitorDockReact nav, #monitorDockFallback nav')]
    .find(dock=>dock.offsetHeight);
}
function measureDockClearance(){
  const dock=visibleMonitorDock();
  if(dock)document.documentElement.style.setProperty('--measured-dock-clearance',
    Math.ceil(window.innerHeight-dock.getBoundingClientRect().top+8)+'px');
}
const dockSizeObserver=new ResizeObserver(measureDockClearance);
window.addEventListener('resize',measureDockClearance);
const reactDockHost=$('monitorDockReact');
const fallbackDockHost=$('monitorDockFallback');
fallbackDockHost.addEventListener('focusin',()=>{fallbackDockHost.dataset.focused='true';});
fallbackDockHost.addEventListener('focusout',event=>{
  if(!fallbackDockHost.contains(event.relatedTarget))delete fallbackDockHost.dataset.focused;
});
new MutationObserver(()=>{
  const dock=reactDockHost.firstElementChild;
  if(dock)dockSizeObserver.observe(dock);
}).observe(reactDockHost,{childList:true});
document.addEventListener('focusin',event=>{
  const target=event.target;
  const main=target.closest?.('.monitor-shell .main');
  if(!main||target===main)return;
  requestAnimationFrame(()=>{
    if(document.activeElement!==target)return;
    const dock=visibleMonitorDock()?.getBoundingClientRect();
    if(!dock)return;
    const rect=target.getBoundingClientRect();
    const gap=8;
    const insideMain=main.scrollHeight>main.clientHeight&&getComputedStyle(main).overflowY==='auto';
    const scrollport=insideMain?main:window;
    const bounds=insideMain?main.getBoundingClientRect():{top:0,bottom:window.innerHeight};
    const top=Math.max(0,bounds.top);
    const intersectsDock=rect.right+gap>dock.left&&rect.left-gap<dock.right;
    const bottom=Math.min(window.innerHeight,bounds.bottom,intersectsDock?dock.top:Infinity);
    const below=rect.bottom+gap-bottom;
    const above=rect.top-gap-top;
    if(below>0||above<0){
      scrollport.scrollBy({top:below>0?Math.ceil(below):Math.floor(above),behavior:'instant'});
    }
  });
});
function syncMonitorDock(reactDock,fallbackDock){
  if(reactDock.dataset.view!==S.view)reactDock.dataset.view=S.view;
  if(!fallbackDock.firstElementChild){
    fallbackDock.innerHTML=`<nav class="monitor-dock dock-tabs" aria-label="Navegação da monitora">
      <span class="dock-tabs-indicator" aria-hidden="true"></span>
      ${MONITOR_DOCK.map(([view,symbol])=>`<button type="button" data-act="nav" data-view="${view}">
        ${icon(symbol)}<span>${LABEL[view]}</span>
      </button>`).join('')}
    </nav>`;
    dockSizeObserver.observe(fallbackDock.firstElementChild);
  }
  for(const button of fallbackDock.querySelectorAll('button')){
    if(button.dataset.view===S.view)button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
}
function yearOptions(){
  return a('years').map(year=>`<option value="${E(year)}" ${String(year)===String(S.year)?'selected':''}>Ano ${E(year)}</option>`).join('');
}
function updateLoadFeedback(){
  const delayed=S.loading&&S.loadingVisible;
  const button=document.querySelector('.topright [data-act=refresh]');
  const status=$('snapshotStatus');
  const text=delayed?'Atualizando os dados…':'';
  const busy=String(delayed);
  if(button&&button.getAttribute('aria-busy')!==busy)button.setAttribute('aria-busy',busy);
  if(status&&status.textContent!==text)status.textContent=text;
  const area=document.querySelector('.main .content');
  if(area)area.setAttribute('aria-busy',String(S.loading&&!hasSnapshot()));
}
function syncSelect(select,markup,value){
  const template=document.createElement('template');
  template.innerHTML=markup;
  const options=[...template.content.children];
  if(options.length!==select.length||options.some((option,index)=>!option.isEqualNode(select.options[index]))){
    select.replaceChildren(...options);
  }
  if(select.value!==String(value)){
    select.value=value;
    if(select.selectedIndex===-1)select.selectedIndex=0;
  }
}
function paintSnapshot(reveal=false){
  if(S.modal||renderedModalType||!S.data||S.view!==renderedView||!$('yearSelect')){
    render();
    if(reveal)document.querySelector('.main .content')?.classList.add('snapshot-reveal');
    return;
  }
  syncSelect($('yearSelect'),yearOptions(),S.year);
  const area=document.querySelector('.main .content');
  const main=$('conteudo'), scrolled=main.scrollTop, windowScroll=window.scrollY;
  if(!hasSnapshot()&&scrolled&&!area.style.minBlockSize)area.style.minBlockSize=area.offsetHeight+'px';
  if(hasSnapshot())area.style.removeProperty('min-block-size');
  const active=document.activeElement;
  const focusId=area.contains(active)?active.id:'';
  const template=document.createElement('template');
  const cardLists=[];
  template.innerHTML=snapshotContent(cardLists);
  const context=disclosureContext();
  restoreDisclosures(template.content,disclosureStates(context===renderedDisclosureContext?area:null));
  renderedDisclosureContext=context;
  patchSections(area,template.content);
  mountStudentCards(area,cardLists);
  area.classList.toggle('snapshot-reveal',reveal);
  announceStudentResults();
  updateLoadFeedback();
  observeReportTables();
  syncRouteMap();
  if(!active.isConnected||document.activeElement!==active){
    const nextFocus=focusId&&$(focusId);
    (nextFocus||(active.isConnected?active:main)).focus({preventScroll:true});
  }
  if(main.scrollTop!==scrolled)main.scrollTop=scrolled;
  if(window.scrollY!==windowScroll)window.scrollTo(0,windowScroll);
}
function patchSections(container,source){
  const oldSections=[...container.children], newSections=[...source.children];
  const retained=new Set();
  for(const [index,next] of newSections.entries()){
    const previous=oldSections[index];
    let node=next;
    if(previous?.id==='routeMap'&&next.id==='routeMap'){
      node=previous;
    }else if(previous?.id==='studentFilters'&&next.id==='studentFilters'){
      syncStudentFilters();
      node=previous;
    }else if(previous?.matches('.cards[data-student-list]')&&next.matches('.cards[data-student-list]')){
      previous.dataset.studentList=next.dataset.studentList;
      node=previous;
    }else if((previous?.matches('.report-scroll-hint')&&previous.id===next.id)||previous?.isEqualNode(next)){
      node=previous;
    }else if(previous?.matches('summary')&&next.matches('summary')){
      previous.replaceChildren(...next.childNodes);
      node=previous;
    }else if(previous&&(
      (next.dataset.disclosure&&previous.dataset.disclosure===next.dataset.disclosure&&previous.open===next.open)||
      (previous.className===next.className&&previous.id===next.id&&
        previous.matches('#studentResults,.school-roster[data-school],.monitor-home,.monitor-grid,.route-guide,.absence-panel,.disclosure-body,.disclosure-inner,.absence-list,.report-panel,.report-table')&&
        previous.dataset.school===next.dataset.school&&previous.dataset.disclosureContext===next.dataset.disclosureContext))){
      patchSections(previous,next);
      node=previous;
    }
    const current=container.children[index];
    if(current!==node){
      // A changed child in the same slot can be replaced without moving its siblings.
      if(previous&&current===previous)previous.replaceWith(node);
      else container.insertBefore(node,current||null);
    }
    retained.add(node);
  }
  for(const previous of oldSections)if(!retained.has(previous))previous.remove();
}
function applySnapshot(data,reveal=false){
  const previous=user(), next=data.user;
  const shellChanged=previous?.perfil!==next?.perfil||previous?.nome!==next?.nome||
    next?.trocarSenha==='SIM'||next?.exigeTroca;
  // A same-context response must not replace data under an active form or scanner.
  if(S.modal&&!shellChanged&&hasSnapshot()){
    updateLoadFeedback();
    return false;
  }
  S.data=data;S.year=data.year;S.day=data.day;
  if(shellChanged){
    render();
    if(reveal)document.querySelector('.main .content')?.classList.add('snapshot-reveal');
  }else paintSnapshot(reveal);
  return true;
}
function snapshotContent(cardLists){return hasSnapshot()?content(cardLists):snapshotPlaceholder();}
function snapshotPlaceholder(){
  const day=S.data&&S.view==='attendance'?hero('Chamada do transporte','Confira os embarques por escola, data, rota e sentido.')+
    `<div class="panel"><div class="attendance-tools"><div class="boarding-route"><label for="callDay">Data</label><input type="date" class="control" id="callDay" value="${E(S.day)}" max="${todayLocal()}"></div></div></div>`:'';
  if(S.loadError)return day+`<section class="panel snapshot-slot">
    <p role="alert">${E(S.loadError)}</p>
    <button class="btn primary" type="button" data-act="refresh">Tentar novamente</button>
    ${!S.data?'<button class="btn" type="button" data-act="logout">Voltar ao login</button>':''}
  </section>`;
  const view=S.view||'dashboard';
  const blocks=(count,classes)=>Array.from({length:count},()=>`<div class="${classes}"><i></i><i></i><i></i></div>`).join('');
  const monitorHome=view==='dashboard'&&role()==='monitor';
  const summary=['dashboard','reports'].includes(view)&&!monitorHome;
  const students=view==='students'||view==='dashboard'&&!monitorHome;
  const status=S.data||!S.loadingVisible?'':'<span class="sr-only" role="status">Carregando o painel…</span>';
  return day+status+`<div class="snapshot-slot skeleton${S.loadingVisible?'':' skeleton-waiting'}" aria-hidden="true">
    ${day?'':'<div class="hero skeleton-heading"><i></i><i></i></div>'}
    ${summary?`<div class="stats">${blocks(4,'stat skeleton-stat')}</div>`:''}
    ${students?`<div class="panel skeleton-filters"><i></i><div class="filters">${'<i></i>'.repeat(4)}</div></div><div class="cards">${blocks(3,'student-card skeleton-card')}</div>`:
      monitorHome?`<div class="monitor-grid">${blocks(2,'panel skeleton-table')}</div>`:`<div class="panel skeleton-table">${'<i></i>'.repeat(5)}</div>`}
  </div>`;
}
function monitorProfile(){
  return `<div class="hero"><h1>Perfil</h1></div>
    <section class="panel monitor-profile" aria-label="Conta da monitora">
      <div class="monitor-profile-identity">
        <div class="avatar" aria-hidden="true">${E(initials(user().nome))}</div>
        <div><strong>${E(user().nome)}</strong><p>Monitor de transporte</p></div>
      </div>
      <div class="monitor-profile-actions">
        <button class="btn" type="button" data-act="nav" data-view="routeMap">${icon('pin')} Mapa de Rotas</button>
        <button class="btn" type="button" data-act="password">${icon('lock')} Alterar senha</button>
        <button class="btn danger" type="button" data-act="logout">${icon('logout')} Sair</button>
      </div>
    </section>`;
}
function loginHtml(){
  return `<main class="auth-bg" id="conteudo" tabindex="-1">
    <div class="auth-layout">
      <section class="auth-intro" aria-labelledby="loginTitle">
        <p class="eyebrow">Rede municipal de ensino</p>
        <h1 id="loginTitle">Gestão do transporte escolar</h1>
        <p>Acompanhe as rotas, os embarques e a frequência dos estudantes da rede municipal.</p>
        <svg class="auth-route-art" viewBox="0 0 440 132" fill="none" aria-hidden="true">
          <path d="M18 103h101c29 0 36-11 51-31l5-7c13-18 25-27 49-27h173" stroke="currentColor" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round"/>
          <circle cx="18" cy="103" r="10" stroke="currentColor" stroke-width="2"/>
          <circle cx="222" cy="38" r="6" fill="currentColor"/>
          <path d="M426 28c0 14-18 30-18 30s-18-16-18-30a18 18 0 1 1 36 0Z" class="art-pin" stroke-width="2.5"/>
          <circle cx="408" cy="28" r="6" class="art-pin" stroke-width="2.5"/>
        </svg>
      </section>
      <section class="auth-card" aria-labelledby="accessTitle">
        <span class="auth-lock">${icon('lock')}</span>
        <h2 id="accessTitle">Acesse sua conta</h2>
        <p class="auth-sub">Use seu e-mail cadastrado e sua senha.</p>
        <form id="loginForm" aria-busy="${S.busy}">
          <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="voce@exemplo.com" maxlength="254" required></div>
          <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Sua senha" required></div>
          <button class="btn primary auth-submit" type="submit" ${S.busy?'disabled':''}>${S.busy?'Entrando…':'Entrar no sistema'}${icon('chevron')}</button>
        </form>
      </section>
    </div>
  </main>`;
}
function hero(title,description,buttons=''){return `<p class="eyebrow">Ano letivo ${E(S.year)}</p><div class="hero"><div><h1>${E(title)}</h1><p>${E(description)}</p></div><div class="actions">${buttons}<button class="btn" type="button" data-act="print">${icon('print')} Imprimir</button></div></div>`;}
function plus(type){return `<button class="btn primary" type="button" data-act="new" data-type="${type}">${icon('plus')} ${type==='student'?'Novo estudante':'Adicionar '+TYPE[type].toLowerCase()}</button>`;}
function stat(title,num,symbol,foot){return `<div class="stat"><div class="stat-head">${E(title)} <span class="stat-ico">${icon(symbol)}</span></div><div class="stat-number">${E(num)}</div><div class="stat-meta">${E(foot)}</div></div>`;}
function stats(dashboard=false){
  const total=a('students').length;
  const assigned=a('students').filter(student=>!!student.rotaId).length;
  const students=stat('Estudantes',total,'people','Cadastrados no ano');
  const linked=stat('Com rota definida',assigned,'check',(total-assigned)+' pendentes');
  const routes=stat('Rotas ativas',a('routes').filter(isActive).length,'route','Rotas autorizadas');
  const stops=stat('Pontos de embarque',a('stops').length,'pin','Pontos cadastrados');
  return `<div class="stats${dashboard?' admin-dashboard-stats':''}">${students}${dashboard?linked+routes+stops:routes+stops+linked}</div>`;
}
function content(cardLists){switch(S.view){case 'routeMap':return routeMapScreen();case 'profile':return monitorProfile();case 'dashboard':return dashboard(cardLists);case 'students':return studentsScreen(cardLists);case 'schools':return listScreen('school','schools');case 'classes':return listScreen('class','classes');case 'routes':return listScreen('route','routes');case 'stops':return listScreen('stop','stops');case 'users':return usersScreen();case 'attendance':return attendanceScreen();case 'reports':return reportsScreen();default:return dashboard(cardLists);}}
function studentFilterOptions(){
  const f=S.filters,routes=a('routes').filter(r=>!f.school||routeSchoolIds(r).includes(f.school));
  const routeIds=new Set(routes.map(r=>r.id));
  const stops=a('stops').filter(p=>routeIds.has(p.rotaId)&&(!f.route||p.rotaId===f.route));
  return [
    ['filterSchool','Todas as escolas',a('schools'),f.school],
    ['filterRoute','Todas as rotas',routes,f.route],
    ['filterStop','Todos os pontos',stops,f.stop]
  ];
}
function filterOptions(label,items,value){return `<option value="">${label}</option>${options(items,value)}`;}
function syncStudentFilters(){
  const search=$('searchStudents');
  if(search.value!==S.filters.search)search.value=S.filters.search;
  for(const [id,label,items,value] of studentFilterOptions())syncSelect($(id),filterOptions(label,items,value),value);
}
function announceStudentResults(){
  const status=$('studentResultStatus'),count=$('studentResultCount');
  if(status&&count&&status.textContent!==count.textContent)status.textContent=count.textContent;
}
function updateStudentResults(){
  clearTimeout(studentSearchTimer);
  const results=$('studentResults');
  if(!results||!hasSnapshot()||S.modal)return;
  const items=filteredStudents();
  const cardLists=[];
  const template=document.createElement('template');
  template.innerHTML=studentResults(S.view==='dashboard'?items.slice(0,12):items,cardLists);
  patchSections(results,template.content);
  mountStudentCards(results,cardLists);
  announceStudentResults();
}
function filtersHtml(){
  const admin=canEdit();
  const title=admin?'Filtrar estudantes':'Encontre estudantes rapidamente';
  const searchLabel=admin?'<label class="filter-label" for="searchStudents">Buscar estudante</label>':'';
  const selectors=studentFilterOptions().map(([id,label,items,value],index)=>{
    const name=['Escola','Rota','Ponto'][index];
    const select=`<select class="control" id="${id}" aria-label="Filtrar ${name.toLowerCase()}">${filterOptions(label,items,value)}</select>`;
    return admin?`<div><label class="filter-label" for="${id}">${name}</label>${select}</div>`:select;
  }).join('');
  return `<div class="panel" id="studentFilters"><div class="panel-head"><div><h2 class="panel-title">${title}</h2><div class="panel-sub">${admin?'Filtre por escola, rota e ponto.':'Combine escola, rota e ponto para refinar sua busca.'}</div></div><button class="btn small" data-act="resetFilters">Limpar filtros</button></div><div class="filters"><div>${searchLabel}<div class="search"><input class="control" id="searchStudents" aria-label="Buscar estudante" value="${E(S.filters.search)}" placeholder="${admin?'Nome, turma ou código do crachá':'Buscar por nome ou código RC do crachá…'}" autocomplete="off"></div></div>
  ${selectors}</div><span class="sr-only" id="studentResultStatus" role="status" aria-atomic="true"></span></div>`;
}
function options(items,selected){return items.map(x=>`<option value="${E(x.id)}" ${x.id===selected?'selected':''}>${E(x.nome)}</option>`).join('');}
function badgeSearchKey(value){return String(value||'').toUpperCase().replace(/[\s-]/g,'');}
const studentNameOrder=new Intl.Collator('pt-BR');
function filteredStudents(){
  const f=S.filters,term=f.search.trim().toLowerCase(),badge=badgeSearchKey(term);
  return a('students').filter(x=>(!f.school||x.escolaId===f.school)&&(!f.route||x.rotaId===f.route)&&(!f.stop||x.pontoId===f.stop)&&(!term||x.nome.toLowerCase().includes(term)||(badge.length>=3&&badgeSearchKey(x.crachaCodigo).includes(badge))||val('classes',x.turmaId).toLowerCase().includes(term))).sort((x,y)=>studentNameOrder.compare(x.nome,y.nome));
}
function studentCard(s,fields){
  const [pending,school,route,stop,address,canManage,canAssign,canReplace]=fields;
  const editButton=`<button type="button" class="link-btn" data-act="edit" data-type="student" data-id="${E(s.id)}" aria-label="${E((pending?'Definir rota e ponto de ':'Alterar rota ou ponto de ')+s.nome)}">${pending?'Definir rota e ponto':'Alterar rota ou ponto'}</button>`;
  const badge=s.qrToken&&s.crachaCodigo
    ?`<button type="button" class="link-btn" data-act="badge" data-id="${E(s.id)}">▦ Crachá QR</button>${canReplace?`<button type="button" class="link-btn" data-act="replaceBadge" data-id="${E(s.id)}">Substituir crachá perdido</button>`:''}`:'';
  const actions=canManage?`<button type="button" class="link-btn" data-act="edit" data-type="student" data-id="${E(s.id)}">Editar estudante</button>${badge}`:canAssign?editButton:'';
  return `<article class="student-card" data-student-id="${E(s.id)}"><div class="student-head"><div class="student-avatar">${E(initials(s.nome))}</div><div class="student-head-title"><b title="${E(s.nome)}">${E(s.nome)}</b><small>${E(school)}</small></div><span class="tag ${pending?'warn':''}">${pending?'Sem rota':'Vinculado'}</span></div><div class="detail-list">${detail('Código do crachá',s.crachaCodigo||'Atualize os dados')}${detail('Rota',route)}${address?detail('Logradouro',address):''}${detail('Ponto',stop)}${s.responsavel?detail('Responsável',s.responsavel):''}${s.celular?detail('Celular',s.celular):''}</div><div class="student-actions">${actions}</div></article>`;
}
function detail(label,value){return `<div class="detail-item"><span>${E(label)}</span><b title="${E(value)}">${E(value)}</b></div>`;}
function schoolGroups(items, schoolOf = item=>item.escolaId){
  const groups=new Map();
  for(const item of items){
    const schoolId=schoolOf(item);
    if(!groups.has(schoolId))groups.set(schoolId,[]);
    groups.get(schoolId).push(item);
  }
  return [...groups].sort(([first],[second])=>val('schools',first).localeCompare(val('schools',second),'pt-BR'));
}
function schoolGroupHeading(schoolId,count){
  const name=find('schools',schoolId)?.nome||'Escola a definir';
  return `<h3 class="school-roster-title">${E(name)} <span>${count} ${count===1?'estudante':'estudantes'}</span></h3>`;
}
// Render plans live only for the current render. Stored cards stay in the DOM
// while their displayed fields and actions remain identical.
const studentCardState=new WeakMap();
function mountStudentCards(root,cardLists){
  if(!cardLists.length)return;
  for(const grid of root.querySelectorAll('.cards[data-student-list]')){
    const previous=new Map([...grid.children].map(card=>[card.dataset.studentId,card]));
    const changed=[];
    const cards=cardLists[grid.dataset.studentList].map(student=>{
      const pending=!student.rotaId;
      const fields=[pending,val('schools',student.escolaId),val('routes',student.rotaId),
        val('stops',student.pontoId),canEdit()?student.logradouro:'',canManageStudent(student),
        role()==='monitor'&&pending,isActive(student)];
      const state=JSON.stringify([...fields,student.nome,student.crachaCodigo,
        Boolean(student.qrToken),student.responsavel,student.celular]);
      const node=previous.get(String(student.id));
      const entry={node:node&&studentCardState.get(node)===state?node:null,previous:node,state};
      if(!entry.node){
        entry.markup=studentCard(student,fields);
        changed.push(entry);
      }
      previous.delete(String(student.id));
      return entry;
    });
    if(changed.length){
      const template=document.createElement('template');
      template.innerHTML=changed.map(entry=>entry.markup).join('');
      [...template.content.children].forEach((node,index)=>{
        changed[index].node=node;
        studentCardState.set(node,changed[index].state);
        changed[index].previous?.replaceWith(node);
      });
      if(!grid.firstElementChild)grid.append(template.content);
    }
    for(const node of previous.values())node.remove();
    for(const [index,entry] of cards.entries()){
      const current=grid.children[index];
      if(current!==entry.node)grid.insertBefore(entry.node,current||null);
    }
    while(grid.children.length>cards.length)grid.lastElementChild.remove();
  }
}
function studentResults(items,cardLists){
  const groups=S.filters.route?schoolGroups(items):[];
  const cards=students=>`<div class="cards" data-student-list="${cardLists.push(students)-1}"></div>`;
  const results=S.filters.route&&groups.length>1?groups.map(([schoolId,students])=>`<section class="school-roster" data-school="${E(schoolId)}">${schoolGroupHeading(schoolId,students.length)}${cards(students)}</section>`).join(''):cards(items);
  return `<div class="section-line"><h2>Estudantes <span id="studentResultCount">${items.length} ${items.length===1?'registro':'registros'}</span></h2><button class="btn small" data-act="export" data-what="students">${canEdit()?'Baixar CSV':'↓ CSV'}</button></div>${items.length?results:empty('Nenhum estudante encontrado','Experimente limpar os filtros ou cadastre novos estudantes.')}`;
}
function empty(t,p){return `<div class="empty"><div class="empty-icon">◎</div><b>${E(t)}</b><div>${E(p)}</div></div>`;}
function dashboard(cardLists){
  if(role()==='monitor')return monitorDashboard();
  return hero('Visão geral',role()==='escola'?'Acompanhe os estudantes e as rotas da sua unidade.':'Acompanhe os estudantes e as rotas da rede municipal.',canEdit()?plus('student'):'')+stats(true)+filtersHtml()+`<div id="studentResults">${studentResults(filteredStudents().slice(0,12),cardLists)}</div>`;
}
function studentsScreen(cardLists){
  const actions = (canManageStudent() ? plus('student') : '') + (canEdit() ? '<button class="btn" data-act="studentImport">Importar planilha</button>' : '');
  return hero('Estudantes transportados','Cadastros e informações de transporte organizados por escola e rota.',actions) + filtersHtml() + `<div id="studentResults">${studentResults(filteredStudents(),cardLists)}</div>`;
}
function subtitles(type,obj){switch(type){case 'school':return 'Escola ativa';case 'class':return val('schools',obj.escolaId)+' · '+obj.ano;case 'route':return [routeSchoolNames(obj),obj.veiculo,!isActive(obj)?'Inativa':''].filter(Boolean).join(' · ');case 'stop':return val('routes',obj.rotaId)+' · Ordem '+obj.ordem;default:return '';}}
function listScreen(type,key){
  const data=a(key);
  const title={school:'Escolas',class:'Turmas',route:'Rotas',stop:'Pontos'}[type];
  const desc={school:'Unidades da rede municipal de educação.',class:'Turmas vinculadas às escolas e ao ano letivo.',route:'Consulte os trajetos e as escolas atendidas.',stop:'Pontos de embarque e desembarque de cada rota.'}[type];
  const allowAdd=canEdit()&&(type!=='stop'||a('routes').some(route=>isActive(route)&&canEditRoute(route)));
  const allowMerge=type==='route'&&role()==='secretaria'&&data.filter(isActive).length>1;
  const rows=data.map((item,index)=>{
    const editable=type==='route'?canEditRoute(item):type==='stop'?canEditRoute(find('routes',item.rotaId)):canEdit();
    const routeAction=type==='route'?`<button class="btn small" data-act="routeStudents" data-id="${E(item.id)}">Ver estudantes</button>`:'';
    const merge=allowMerge&&isActive(item)?`<button class="btn small" data-act="mergeRoutes" data-id="${E(item.id)}">Unificar</button>`:'';
    return `<div class="list-row">${type==='route'?'':`<div class="list-number">${String(index+1).padStart(2,'0')}</div>`}<div class="list-main"><b>${E(item.nome)}</b><small>${E(subtitles(type,item))}</small></div><div class="list-actions">${routeAction}${editable?`<button class="btn small" data-act="edit" data-type="${type}" data-id="${E(item.id)}">Editar</button>${merge}${isActive(item)?`<button class="btn small danger" data-act="disable" data-type="${type}" data-id="${E(item.id)}">Desativar</button>`:''}`:''}</div></div>`;
  });
  return hero(title,desc,allowAdd?plus(type):'')+`<div class="panel"><div class="panel-head"><div><div class="panel-title">${title}</div><div class="panel-sub">${data.filter(isActive).length} registros ativos</div></div><button class="btn small" data-act="export" data-what="${key}">Baixar CSV</button></div>${rows.length?`<div class="rows">${rows.join('')}</div>`:empty('Nenhum registro','Crie o primeiro cadastro para esta seção.')}</div>`;
}
const ICONS={
  person:'<circle cx="12" cy="8" r="3.25"/><path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/>',
  graduation:'<path d="m2.5 9.5 9.5-5 9.5 5-9.5 5-9.5-5Zm4 2v5c3.7 3.5 7.3 3.5 11 0v-5m4-2v6"/>',
  home:'<path d="m3 11 9-7 9 7M5 10v10h14V10M10 20v-6h4v6"/>',
  people:'<circle cx="9" cy="8" r="3"/><path d="M3 19v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1M16 5.2a3 3 0 0 1 0 5.6M18 14a4 4 0 0 1 3 4v1"/>',
  school:'<path d="M3 20h18M5 20V10l7-6 7 6v10M10 20v-5h4v5M12 10v.01"/>',
  classes:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h3"/>',
  route:'<circle cx="5" cy="17" r="2"/><circle cx="19" cy="7" r="2"/><path d="M7 17h8a3 3 0 0 0 0-6H9a2 2 0 1 1 0-4h8"/>',
  pin:'<path d="M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  checklist:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="m8 10 1 1 2-2m2 2h3m-8 4 1 1 2-2m2 2h3"/>',
  chart:'<path d="M4 4v16h16M8 16v-4m4 4V7m4 9v-6"/>',
  lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 1 1 8 0v2m-4 4v2"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5m10.2-3.1A7.8 7.8 0 0 0 6 6m-1.2 9.1A7.8 7.8 0 0 0 18 18"/>',
  logout:'<path d="M12 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6m3-12 5 5-5 5m-6-5h11"/>',
  print:'<path d="M7 8V4h10v4m0 8h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2"/><path d="M7 14h10v6H7zM7 11h.01"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  alert:'<path d="M10.3 4.9 3 18a1.5 1.5 0 0 0 1.3 2h15.4a1.5 1.5 0 0 0 1.3-2L13.7 4.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3h.01"/>',
  qr:'<path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5M9 9h2v2H9zm4 4h2v2h-2zm-4 4h2m6-6h2"/>'
};
function icon(name){
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
function chooseRoute(routes){
  if(!routes.some(r=>r.id===S.route))S.route=routes.length===1||role()!=='monitor'?(routes[0]?.id||''):'';
  return routes.find(r=>r.id===S.route);
}
function routePicker(routes,route,withSchools=false){
  const schools=withSchools?routeSchoolNames(route):'';
  const detail=schools?`<small>${E(schools)}</small>`:'';
  if(routes.length===1&&role()==='monitor')return `<div class="boarding-route boarding-route-fixed"><span>Rota</span><strong>${E(route.nome)}</strong>${detail}</div>`;
  return `<div class="boarding-route"><label for="callRoute">Rota</label><select class="control" id="callRoute">${route?'':'<option value="">Selecione sua rota</option>'}${options(routes,S.route)}</select>${detail}</div>`;
}
function compareStops(first,second){
  const order=point=>Number(point.ordem)>0?Number(point.ordem):Infinity;
  return order(first)-order(second)||String(first.nome).localeCompare(String(second.nome),'pt-BR');
}
function routePointsPanel(route,expanded=false){
  if(!route)return '';
  const points=a('stops').filter(point=>point.rotaId===route.id&&isActive(point)).sort(compareStops);
  const body=`<p>Use os nomes dos locais para se orientar. Sequência cadastrada dos pontos:</p>
    ${points.length?`<ol class="route-point-list">${points.map(point=>`<li ${Number(point.ordem)>0?`value="${Number(point.ordem)}"`:''}><strong>${E(point.nome)}</strong></li>`).join('')}</ol>`:'<p>Nenhum ponto cadastrado para esta rota.</p>'}`;
  const key=JSON.stringify(['points',route.id]);
  const label=`Pontos de referência · ${E(route.nome)} <span class="disclosure-meta">${points.length} pontos</span>`;
  return `<section class="panel route-guide" data-disclosure-context="${E(key)}">${disclosure(key,label,body,{open:expanded})}</section>`;
}
function canManageDay(route,day){
  return role()!=='escola'&&isActive(route)&&day.slice(0,4)===S.year&&day<=todayLocal();
}
function routeDayClosed(routeId,day){
  return a('closedDays').some(entry=>entry.routeId===routeId&&entry.day===day);
}
function routeDayButton(route,day){
  if(!canManageDay(route,day))return '';
  const closed=routeDayClosed(route.id,day);
  return `<div class="route-day"><div><strong>${closed?'Dia encerrado':'Dia em aberto'}</strong><small>${closed?'Este dia entra na contagem de ausências.':'Encerre depois de conferir a ida e a volta.'}</small></div><button type="button" class="btn" data-act="routeDay" data-day="${E(day)}">${closed?'Reabrir dia':'Encerrar dia'}</button></div>`;
}
function boardingActions(route,day){
  const available=canManageDay(route,day)&&day===todayLocal();
  let hint='Toque no sentido da viagem para abrir a câmera.';
  if(!route)hint='Selecione a rota para começar.';
  else if(!isActive(route))hint='Selecione uma rota ativa para registrar embarques.';
  else if(S.year!==todayLocal().slice(0,4))hint='Selecione o ano letivo atual para registrar embarques.';
  else if(!available)hint='Selecione a data de hoje para registrar embarques.';
  return `<div class="boarding-actions"><div class="boarding-directions">${Object.keys(DIRECTION).map(direction=>`
    <button type="button" class="direction-btn direction-${direction.toLowerCase()}" data-act="scan" data-direction="${direction}" aria-describedby="boardingHint" ${available?'':'disabled'}>
      <span class="direction-icon">${icon(direction==='IDA'?'graduation':'home')}</span><span><strong>${DIRECTION[direction]}</strong><small aria-hidden="true">${direction==='IDA'?'Ida':'Volta'}</small></span>
      <span class="direction-arrow">${icon('chevron')}</span>
    </button>`).join('')}</div><p class="boarding-hint" id="boardingHint">${hint}</p></div>`;
}
function absencePanel(routeId='',schoolId=''){
  const alerts=a('absenceAlerts').filter(alert=>(!routeId||alert.rotaId===routeId)&&(!schoolId||alert.escolaId===schoolId));
  const pending=alerts.filter(alert=>!alert.motivo);
  const recorded=alerts.filter(alert=>alert.motivo);
  const row=alert=>`<li class="absence-row"><div><strong>${E(alert.nome)}</strong><small>${E(val('schools',alert.escolaId))} · ${E(val('routes',alert.rotaId))} · ${E(alert.dias)} dias · ${dateHuman(alert.inicio)} a ${dateHuman(alert.fim)}</small></div><button class="btn" type="button" data-act="absence" data-id="${E(alert.id)}" aria-label="${E((alert.motivo?'Ver motivo de ':'Justificar ausência de ')+alert.nome)}">${alert.motivo?'Ver motivo':'Justificar'}</button></li>`;
  const historyKey=JSON.stringify(['absence',routeId,schoolId]);
  return `<section class="panel absence-panel" aria-labelledby="absenceTitle" data-disclosure-context="${E(historyKey)}">
    <div class="absence-head ${pending.length?'has-alerts':''}"><span class="absence-icon">${icon(pending.length?'alert':'checkCircle')}</span><div><h2 id="absenceTitle" tabindex="-1">Alertas de ausência ${pending.length?`<span class="absence-count" aria-label="${pending.length} a justificar">${pending.length}</span>`:''}</h2><p>${pending.length?'Estudantes com 3 ou mais dias seguidos sem embarque.':'Nenhuma ausência a justificar.'}</p></div></div>
    ${pending.length?`<ul class="absence-list">${pending.map(row).join('')}</ul>`:''}
    ${recorded.length?disclosure(historyKey,`Motivos registrados (${recorded.length})`,`<ul class="absence-list">${recorded.map(row).join('')}</ul>`,{className:'absence-history'}):''}
  </section>`;
}
function latestBoarding(route,day){
  if(!route)return '';
  let latest;
  if(S.data.day===day){
    for(const call of a('calls')){
      if(call.rotaId!==route.id||call.status!=='PRESENTE'||!call.registradoEm)continue;
      const timestamp=Date.parse(call.registradoEm);
      if(Number.isFinite(timestamp)&&(!latest||timestamp>Date.parse(latest.registradoEm)))latest=call;
    }
  }
  const student=latest&&find('students',latest.estudanteId);
  const detail=latest?[student?.nome,DIRECTION[latest.sentido],timeHuman(latest.registradoEm)].filter(Boolean).join(' · ')
    :S.data.day===day?'Nenhum embarque registrado hoje.':'Confira os registros de hoje na chamada.';
  return `<div class="latest-boarding">
    <span class="latest-boarding-icon">${icon(latest?'checkCircle':'checklist')}</span>
    <div><h3>Último embarque</h3><p>${E(detail)}</p></div>
  </div>`;
}
function monitorDashboard(){
  const day=todayLocal();
  const routes=a('routes').filter(isActive);
  const route=chooseRoute(routes);
  const shiftLabels=new Map([['MANHA','Manhã'],['TARDE','Tarde']]);
  const shifts=[...new Set([route?.turno,...(Array.isArray(route?.turnos)?route.turnos:[])]
    .map(shift=>shiftLabels.get(String(shift??'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase())).filter(Boolean))];
  return `<div class="monitor-home">
    <header class="monitor-heading">
      <time datetime="${day}">${dateHuman(day)}</time>
      <h1>Embarques de hoje</h1>
    </header>
    ${routes.length?`<div class="monitor-grid">
      <section class="panel boarding-panel" aria-labelledby="boardingTitle">
        <div class="monitor-route-context">
          ${routePicker(routes,route,true)}
          ${shifts.length?`<span class="monitor-shift">${shifts.join(' e ')}</span>`:''}
        </div>
        <h2 class="panel-title" id="boardingTitle">Registrar embarque</h2>
        ${boardingActions(route,day)}
        ${latestBoarding(route,day)}
        <button class="btn boarding-list-link" type="button" data-act="todayCalls">Ver lista de chamada ${icon('chevron')}</button>
        ${routeDayButton(route,day)}
      </section>
      ${absencePanel()}
      ${routePointsPanel(route)}
    </div>`:empty('Nenhuma rota vinculada','A Secretaria pode vincular até duas rotas ao seu acesso.')}</div>`;
}
function attendanceRoster(route){
  const schools=routeSchools(route);
  const schoolId=schools.length>1&&schools.some(school=>school.id===S.callSchool)?S.callSchool:'';
  const calls=new Map(a('calls').filter(c=>c.sentido===S.sentido&&c.rotaId===S.route).map(c=>[c.estudanteId,c]));
  const schoolOf=student=>calls.get(student.id)?.escolaId||student.escolaId;
  const stopOf=student=>calls.has(student.id)?calls.get(student.id).pontoId:student.pontoId;
  const points=a('stops').filter(point=>point.rotaId===route?.id).sort(compareStops);
  const stopId=points.some(point=>point.id===S.callStop)?S.callStop:'';
  const items=a('students').filter(student=>route&&(calls.has(student.id)||(student.escolaId&&student.rotaId===route.id&&isActive(student)))&&
    (!schoolId||schoolOf(student)===schoolId)&&(!stopId||stopOf(student)===stopId)).sort((first,second)=>first.nome.localeCompare(second.nome,'pt-BR'));
  return {schools,schoolId,calls,schoolOf,items,points,stopId};
}
function attendanceScreen(){
  const routes=a('routes');
  const route=chooseRoute(routes);
  const editable=canManageDay(route,S.day);
  const {schools,schoolId,calls,schoolOf,items,points,stopId}=attendanceRoster(route);
  const schoolFilter=schools.length>1?`<div class="boarding-route"><label for="callSchool">Escola</label><select class="control" id="callSchool"><option value="">Todas as escolas</option>${options(schools,schoolId)}</select></div>`:'';
  const present=items.filter(s=>calls.get(s.id)?.status==='PRESENTE').length;
  const absent=items.filter(s=>calls.get(s.id)?.status==='AUSENTE').length;
  const groups=schoolGroups(items,schoolOf);
  const row=s=>{
    const call=calls.get(s.id),status=call?.status||'PENDENTE',time=timeHuman(call?.registradoEm);
    const source={QR:'QR lido',CODIGO:'Código digitado',MANUAL:'Chamada manual'}[call?.origem];
    return `<div class="call-row"><div class="student-avatar">${E(initials(s.nome))}</div><div class="list-main"><b>${E(s.nome)}</b><small>${s.crachaCodigo?E(s.crachaCodigo)+' · ':''}${E(val('stops',call?call.pontoId:s.pontoId))}${source?' · '+source:''}${time?' · '+E(time):''}</small></div><span class="call-status ${E(status)}">${E({PRESENTE:'Presente',AUSENTE:'Ausente',PENDENTE:'Não registrado'}[status]||status)}</span>${editable&&!call?`<button class="btn small" data-act="mark" data-id="${E(s.id)}" data-status="PRESENTE">✓ Presente</button><button class="btn small" data-act="mark" data-id="${E(s.id)}" data-status="AUSENTE">Ausente</button>`:''}</div>`;
  };
  return hero('Chamada do transporte','Confira os embarques por escola, data, rota e sentido.')+
    `<section class="panel attendance-panel"><div class="attendance-tools ${schoolFilter?'with-school-filter':''}">
      <div class="boarding-route"><label for="callDay">Data</label><input type="date" class="control" id="callDay" value="${E(S.day)}" max="${todayLocal()}"></div>
      ${routePicker(routes,route)}
      <div class="boarding-route"><label for="callDirection">Exibir viagem</label><select class="control" id="callDirection">${Object.keys(DIRECTION).map(key=>`<option value="${key}" ${S.sentido===key?'selected':''}>${DIRECTION[key]}</option>`).join('')}</select></div>
      ${schoolFilter}
    </div>
    ${points.length?`<div class="boarding-route attendance-point-filter"><label for="callStop">Ponto de referência</label><select class="control" id="callStop"><option value="">Todos os pontos</option>${points.map(point=>`<option value="${E(point.id)}" ${point.id===stopId?'selected':''}>${E(point.ordem?point.ordem+'. ':'')}${E(point.nome)}</option>`).join('')}</select></div>`:''}
    ${role()!=='escola'?`<div class="attendance-scan">${boardingActions(route,S.day)}${routeDayButton(route,S.day)}</div>`:''}</section>
    ${routePointsPanel(route)}
    ${role()!=='escola'&&route?absencePanel(route.id,schoolId):''}
    <div class="panel"><div class="panel-head"><div><div class="panel-title">Lista de chamada</div><div class="panel-sub">${items.length} estudantes · ${DIRECTION[S.sentido]}${route?' · '+E(route.nome)+' · '+dateHuman(S.day):''}${stopId?' · '+E(val('stops',stopId)):''}</div></div>${route?'<button class="btn small" data-act="export" data-what="calls">↓ CSV</button>':''}</div>
    ${route?`<div class="tip"><b>${present}</b> presentes · <b>${absent}</b> ausentes · <b>${items.length-present-absent}</b> aguardando registro</div>`:''}
    ${groups.length?groups.map(([id,students])=>`<section class="school-roster">${schoolGroupHeading(id,students.length)}${students.map(row).join('')}</section>`).join(''):
      empty(route?'Nenhum estudante nesta lista':'Selecione uma rota',route?'Confira os filtros de escola e ponto e os vínculos dos estudantes.':'Escolha uma rota para conferir a chamada.')}</div>`;
}
function routeSummary(){
  const students=a('students').filter(isActive);
  const points=a('stops');
  return a('routes').map(route=>{
    const schools=routeSchools(route).map(school=>({
      ...school,count:students.filter(student=>student.rotaId===route.id&&student.escolaId===school.id).length
    }));
    return {route,schools,total:schools.reduce((sum,school)=>sum+school.count,0),points:points.filter(point=>point.rotaId===route.id).length};
  });
}
function reportTable(id,head,rows){
  return `<p class="report-scroll-hint" id="${id}ScrollHint" hidden><span aria-hidden="true">↔</span> Role a tabela na horizontal para ver mais colunas.</p>
  <div class="table-wrap report-table" id="${id}Table" role="region" aria-labelledby="${id}">
    <table class="data-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}
function updateReportTable(region){
  const overflow=region.scrollWidth-region.clientWidth>1;
  const hint=$(region.getAttribute('aria-labelledby')+'ScrollHint');
  hint.hidden=!overflow;
  if(overflow){
    region.tabIndex=0;
    region.setAttribute('aria-describedby',hint.id);
  }else{
    region.removeAttribute('tabindex');
    region.removeAttribute('aria-describedby');
  }
}
const reportSizeObserver=new ResizeObserver(entries=>{
  for(const {target} of entries)if(target.isConnected)updateReportTable(target.closest('.report-table'));
});
function observeReportTables(){
  reportSizeObserver.disconnect();
  for(const region of document.querySelectorAll('.report-table')){
    updateReportTable(region);
    reportSizeObserver.observe(region);
    reportSizeObserver.observe(region.firstElementChild);
  }
}
function reportsScreen(){
  const pending=a('students').filter(student=>!student.rotaId);
  const rows=routeSummary().map(({route,schools,total,points})=>`<tr>
    <td><strong>${E(route.nome)}</strong></td><td>${total}</td>
    <td><ul class="school-counts">${schools.map(school=>`<li>${E(school.nome)} <strong>${school.count}</strong></li>`).join('')}</ul></td>
    <td>${points}</td></tr>`).join('');
  return hero('Relatórios e impressão','Acompanhe os totais por rota e por escola.')+stats()+`
    <div class="panel report-panel"><div class="panel-head"><h2 class="panel-title" id="routeReportTitle">Consolidado por rota</h2>
      <button class="btn small report-export" data-act="export" data-what="routesSummary">Baixar CSV</button></div>
      ${reportTable('routeReportTitle','<th>Rota</th><th>Total de estudantes ativos</th><th>Estudantes por escola</th><th>Pontos</th>',rows)}</div>
    <div class="panel"><div class="panel-head"><div><div class="panel-title">Aguardando definição de rota</div><div class="panel-sub">${pending.length} estudantes sem rota</div></div></div>
      ${pending.length?pending.map(s=>`<div class="list-row"><div class="list-main"><b>${E(s.nome)}</b><small>${E(val('schools',s.escolaId))} · ${E(val('classes',s.turmaId))}</small></div></div>`).join(''):empty('Todos os estudantes estão vinculados','Não há pendências de rota entre os estudantes visíveis.')}</div>
    ${role()==='secretaria'?`<div class="panel report-panel"><div class="panel-head"><div><h2 class="panel-title" id="auditReportTitle">Histórico recente de alterações</h2><div class="panel-sub">Últimos 80 eventos registrados</div></div></div>
      ${reportTable('auditReportTitle','<th>Data</th><th>Usuário</th><th>Ação</th><th>Tipo</th>',a('audit').map(x=>`<tr><td>${E(x.data.replace('T',' ').slice(0,19))}</td><td>${E(val('users',x.usuarioId,'nome'))}</td><td>${E(x.acao)}</td><td>${E(x.entidade)}</td></tr>`).join(''))}</div>`:''}`;
}
function usersScreen(){
  const users=a('users');
  return hero('Usuários e acessos','Gerencie as contas e as rotas vinculadas aos monitores.',`<button class="btn primary" data-act="new" data-type="user">＋ Novo usuário</button>${S.year==='2026'?'<button class="btn" data-act="monitorSetup">Configurar Leites e Simão</button>':''}<button class="btn" data-act="newYear">＋ Ano letivo</button>`)+
    `<div class="tip">Cada monitor pode ter até duas rotas por ano letivo. Uma mesma rota pode ter vários monitores, cada um com seu próprio acesso, trabalhando ao mesmo tempo. Sair de um acesso não desconecta os demais. A escola acessa somente seus próprios registros.</div>
    <div class="panel"><div class="panel-head"><div><div class="panel-title">Contas cadastradas</div><div class="panel-sub">${users.length} usuários</div></div><button class="btn small" data-act="export" data-what="users">↓ CSV</button></div>
    <div class="rows">${users.map(u=>{
      const monitor=u.perfil==='monitor';
      const names=a('assignments').filter(item=>item.usuarioId===u.id).map(item=>find('routes',item.rotaId)).filter(isActive).map(r=>r.nome);
      return `<div class="list-row"><div class="avatar">${E(initials(u.nome))}</div><div class="list-main"><b>${E(u.nome)} ${!isActive(u)?'<span class="tag warn">Inativo</span>':''}</b><small>${E(u.email||'E-mail ainda não vinculado')} · ${E({secretaria:'Secretaria',escola:'Escola',monitor:'Monitor'}[u.perfil])}${u.escolaId?' · '+E(val('schools',u.escolaId)):''}</small>${monitor?`<small class="user-route-names">${names.length?E(names.join(' · ')):'Sem rota vinculada'}</small>`:''}</div><div class="list-actions">
      <button class="btn small" data-act="edit" data-type="user" data-id="${E(u.id)}">Editar</button>
      ${monitor&&isActive(u)?`<button class="btn small" data-act="assign" data-id="${E(u.id)}">${names.length?'Editar rotas':'Vincular rotas'}</button>`:''}</div></div>`;
    }).join('')}</div></div>`;
}
function adminForm(){
  return canEdit()&&['student','school','class','route','stop','user'].includes(S.modal?.type);
}
function fieldLabel(label,attributes){
  return E(label)+(adminForm()&&/(?:^|\s)required(?:\s|$)/.test(attributes)?' <span class="required-mark" aria-hidden="true">*</span>':'');
}
function formSection(title,fields){
  return `<fieldset class="form-section wide"><legend>${E(title)}</legend><div class="form-grid">${fields}</div></fieldset>`;
}
function field(k,label,value,placeholder='',extra=''){return `<div class="field"><label for="f_${k}">${fieldLabel(label,extra)}</label><input id="f_${k}" name="${k}" value="${E(value||'')}" placeholder="${E(placeholder)}" ${extra}></div>`;}
function selectField(k,label,items,selected,placeholder='Selecione uma opção',extra=''){return `<div class="field"><label for="f_${k}">${fieldLabel(label,extra)}</label><select id="f_${k}" name="${k}" ${extra}><option value="">${E(placeholder)}</option>${options(items,selected)}</select></div>`;}
function importSchools() {
  return a('schools').filter(school => ![false, 'false', 'NAO'].includes(school.ativo));
}
function studentImportForm(m) {
  const error = m.error ? `<div class="tip warn" role="alert">${E(m.error)}</div>` : '';
  const result = m.result || m.preview;
  if (!result) {
    const schools = importSchools();
    if (!schools.length) return '<div class="tip warn">É preciso ter uma escola ativa para importar.</div>';
    const scope = role() === 'secretaria'
      ? selectField('escolaId', 'Escola da lista', schools, m.escolaId, 'Selecione a escola', 'required')
      : `<p class="import-context"><strong>${E(val('schools', m.escolaId))}</strong></p>`;
    return `<form id="modalForm" data-form="studentImport">
      ${error}${scope}
      <div class="field import-file">
        <label for="studentWorkbook">Planilha de estudantes (.xlsx)</label>
        <input type="file" id="studentWorkbook" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
        <small>Colunas <b>Nome</b>, <b>Logradouro</b> e <b>Rota (Bairro)</b></small>
      </div>
      <div class="tip">Importe um arquivo por escola. Um bairro já cadastrado pode usar a mesma rota do ano letivo.</div>
      <div class="modal-actions">
        <button class="btn" type="button" data-act="closeModal">Cancelar</button>
        <button class="btn primary" type="submit" ${S.busy?'disabled':''}>${S.busy?'Analisando…':'Analisar planilha'}</button>
      </div>
    </form>`;
  }

  const { counts, issues, routes, sharedRoutes = [] } = result;
  const pending = counts.created + counts.updated;
  const metrics = [['Novos', counts.created], ['Atualizados', counts.updated],
    ['Já cadastrados', counts.existing], ['Para revisar', counts.review]];
  const routeLabel = routes.length === 1 ? (m.result ? 'rota criada' : 'rota nova') : (m.result ? 'rotas criadas' : 'rotas novas');
  const importContext=m.result?'result':'preview';
  const routeTags=items=>`<div class="import-routes">${items.map(route => `<span class="pill">${E(route)}</span>`).join('')}</div>`;
  const routeList=routes.length?disclosure(importContext+'-routes',`${routes.length} ${routeLabel}`,routeTags(routes),{className:'import-details'}):'';
  const sharedList=sharedRoutes.length?disclosure(importContext+'-shared',`${m.result?'Rotas vinculadas a esta escola':'Rotas que passarão a atender esta escola'} (${sharedRoutes.length})`,routeTags(sharedRoutes),{className:'import-details',open:true}):'';
  const review=issues.length?disclosure(importContext+'-review','Linhas para revisar',
    `<ul class="import-issues">${issues.map(issue => `<li><b>Linha ${E(issue.line)}${issue.nome?' · '+E(issue.nome):''}</b><span>${E(issue.reason)}</span></li>`).join('')}</ul>`,{className:'import-details',open:true}):'';
  const status = result.needsReview ? '<div class="tip warn" role="status">A base mudou. Confira a prévia atualizada para continuar.</div>' : '';
  const repeated = counts.repeated ? `<p class="import-context">${counts.repeated} ${counts.repeated===1?'linha repetida ignorada':'linhas repetidas ignoradas'}</p>` : '';
  const actions = m.result
    ? '<button class="btn primary" type="button" data-act="closeModal">Concluir</button>'
    : `<button class="btn" type="button" data-act="resetStudentImport">Escolher outro arquivo</button>
       <button class="btn primary" type="submit" ${S.busy||!pending?'disabled':''}>${S.busy?'Importando…':`Confirmar importação (${pending})`}</button>`;

  return `<form id="modalForm" data-form="studentImport">
    ${error}${status}
    <div class="import-context"><strong>${E(val('schools', m.escolaId))}</strong><span>${E(m.fileName)} · Aba ${E(m.sheetName)}</span></div>
    <div class="import-summary" id="importSummary" tabindex="-1" aria-label="Resumo da importação">
      ${metrics.map(([label, count]) => `<div><strong>${count}</strong><span>${E(label)}</span></div>`).join('')}
    </div>
    ${repeated}${routeList}${sharedList}${review}
    <div class="modal-actions">${actions}</div>
  </form>`;
}
function monitorSetupDialog(m){
  if(!m.plan)return `<p role="status">${E(m.error||'Consultando as rotas e os acessos…')}</p>${m.error?'<button class="btn" type="button" data-act="monitorSetup">Tentar novamente</button>':''}`;
  const routes=a('routes').filter(isActive);
  const schools=a('schools').filter(isActive);
  return `<form id="modalForm" data-form="monitorSetup">
    <p class="tip">Os bairros serão reunidos em duas rotas, com os pontos de embarque como referência. Confira as rotas existentes ou escolha as escolas atendidas para criar uma rota que ainda não existe.</p>
    ${m.plan.groups.map(group=>`<fieldset class="monitor-setup-group"><legend>${E(group.nome)} · ${group.stops.length} pontos</legend>
      <p><strong>Bairros reunidos:</strong> ${E((group.bairros||[]).join(', '))}</p>
      ${selectField('route_'+group.key,'Rota cadastrada',routes,m.routeIds[group.key],'Criar a rota '+group.nome)}
      <fieldset class="assignment-field route-school-field"><legend>Escolas atendidas</legend>
        <div class="select-list">${schools.map(school=>`<label class="check-row"><input type="checkbox" name="schools_${E(group.key)}" value="${E(school.id)}" ${(m.schoolIds?.[group.key]||[]).includes(school.id)?'checked':''}><span>${E(school.nome)}</span></label>`).join('')||'<p class="assignment-empty">Cadastre uma escola ativa na seção Escolas para criar esta rota.</p>'}</div>
      </fieldset>
      ${group.monitors.map(monitor=>`<div class="monitor-setup-account"><strong>${E(monitor.nome)}</strong><p>E-mail: <b>${E(monitor.email)}</b></p>
        ${monitor.exists?'<p>Conta vinculada. A senha atual será mantida.</p>':'<p>O perfil será vinculado à conta já criada no Authentication do Supabase.</p>'}
      </div>`).join('')}
      ${disclosure('setup-'+group.key,'Conferir os pontos na ordem do arquivo',`<ol>${group.stops.map(name=>`<li>${E(name)}</li>`).join('')}</ol>`)}
    </fieldset>`).join('')}
    <p class="tip">As escolas já atendidas, os estudantes, os crachás e os históricos serão preservados. Os pontos existentes manterão seus vínculos. Cada monitora usará seu e-mail e a senha já cadastrada.</p>
    ${modalActions(false,'Salvar acessos e pontos')}
  </form>`;
}
async function openMonitorSetup(){
  if(role()!=='secretaria'||S.year!=='2026')return;
  const m={type:'monitorSetup',year:S.year,routeIds:{},schoolIds:{}};
  S.modal=m;render();
  try{
    const plan=await api('monitorSetupPreview',{year:m.year});
    if(S.modal!==m)return;
    m.plan=plan;m.routeIds=Object.fromEntries(plan.groups.map(group=>[group.key,group.routeId]));
    m.schoolIds=Object.fromEntries(plan.groups.map(group=>[group.key,group.schoolIds||find('routes',group.routeId)?.escolaIds||[]]));
  }catch(error){if(S.modal!==m)return;m.error=error.message;warn(error);}
  if(S.modal===m){render();$('modalTitle')?.focus();}
}
function routeMonitorNames(routeId,exceptUserId){
  const userIds=new Set(a('assignments').filter(item=>item.rotaId===routeId&&String(item.ano)===String(S.year)).map(item=>item.usuarioId));
  return a('users').filter(u=>u.id!==exceptUserId&&u.perfil==='monitor'&&isActive(u)&&userIds.has(u.id)).map(u=>u.nome);
}
function assignmentDialog(m){
  const routes=a('routes').filter(isActive);
  return `<form id="modalForm" data-form="assign">
    <p class="assignment-intro">Selecione até duas rotas para o ano letivo de ${E(S.year)}.</p>
    <p class="tip">Você pode selecionar uma rota que já tenha outro monitor. Os vínculos existentes serão mantidos e todos poderão acessar a rota ao mesmo tempo, com suas contas individuais.</p>
    <fieldset class="assignment-field"><legend>Rotas disponíveis</legend>
      <p id="assignmentCount" role="status"></p>
      <div class="select-list">${routes.map(r=>{const monitors=routeMonitorNames(r.id,m.id);return `<label class="check-row"><input type="checkbox" name="routeId" value="${E(r.id)}" ${m.routeIds.includes(r.id)?'checked':''}><span><strong>${E(r.nome)}</strong><small>${E(routeSchoolNames(r))}</small>${monitors.length?`<small>Outros monitores nesta rota: ${E(monitors.join(', '))}</small>`:''}</span></label>`;}).join('')||'<p class="assignment-empty">Cadastre uma rota ativa para vincular.</p>'}</div>
    </fieldset>${modalActions(false,'Salvar vínculos')}
  </form>`;
}
function syncAssignmentForm(form){
  if(!form)return;
  const boxes=Array.from(form.querySelectorAll('input[name="routeId"]'));
  S.modal.routeIds=boxes.filter(box=>box.checked).map(box=>box.value);
  const count=S.modal.routeIds.length;
  for(const box of boxes)box.disabled=count>=2&&!box.checked;
  $('assignmentCount').textContent=count>2?'Reduza a seleção para duas rotas.':count+' de 2 selecionadas';
  form.querySelector('button[type="submit"]').disabled=S.busy||count>2;
}
function absenceDialog(m){
  const alert=m.alert;
  return `<form id="modalForm" data-form="absence">
    <div class="absence-period"><strong>${E(val('routes',alert.rotaId))}</strong><span>${E(alert.dias)} dias · ${dateHuman(alert.inicio)} a ${dateHuman(alert.fim)}</span></div>
    <div class="field"><label for="absenceReason">Motivo</label><textarea id="absenceReason" name="reason" rows="4" maxlength="500" placeholder="Descreva brevemente o motivo…" required>${E(m.draftReason)}</textarea></div>
    <p class="boarding-hint">Registre apenas o necessário para o acompanhamento.</p>
    ${modalActions(false,'Salvar motivo')}
  </form>`;
}
function routeDayDialog(m){
  const shared=find('routes',m.routeId)?.compartilhada;
  const description=m.closed?'Este dia volta a ficar em aberto e sai da contagem até ser encerrado novamente.':
    `Confirme depois de conferir a ida e a volta${shared?' de todas as escolas da rota':''}. O dia conta como ausência para quem não teve embarque em nenhuma das viagens.`;
  return `<form id="modalForm" data-form="routeDay"><p class="transport-explain">${description}</p>${modalActions(false,m.closed?'Reabrir dia':'Encerrar dia')}</form>`;
}
function routeLabel(route){return [route.nome,routeSchoolNames(route),route.veiculo].filter(Boolean).join(' · ');}
function mergeRoutesDialog(m){
  const primary=find('routes',m.id);
  const candidates=a('routes').filter(route=>isActive(route)&&route.id!==m.id);
  const matching=candidates.filter(route=>route.nome.localeCompare(primary.nome,'pt-BR',{sensitivity:'base'})===0);
  const selected=m.secondaryId||(matching.length===1?matching[0].id:'');
  const choices=candidates.map(route=>({id:route.id,nome:routeLabel(route)}));
  return `<form id="modalForm" data-form="mergeRoutes">
    ${selectField('secondaryId','Outra rota do mesmo trajeto',choices,selected,'Selecione uma rota','required')}
    <p class="tip">As escolas, os estudantes, os pontos e as chamadas das duas rotas ficarão no cadastro principal. Os monitores vinculados poderão registrar os embarques das escolas atendidas.</p>
    ${modalActions(false,'Unificar rotas')}
  </form>`;
}
function routeSchoolFields(selected){
  const schools=a('schools').filter(school=>isActive(school)||selected.includes(school.id));
  return `<fieldset class="assignment-field route-school-field wide"><legend>${fieldLabel('Escolas atendidas','required')}</legend>
    <div class="select-list">${schools.map(school=>`<label class="check-row"><input type="checkbox" name="escolaIds" value="${E(school.id)}" ${selected.includes(school.id)?'checked':''}><span>${E(school.nome)}</span></label>`).join('')||'<p class="assignment-empty">Cadastre uma escola ativa para vincular.</p>'}</div>
  </fieldset>`;
}
function scannerNoticeState(m){
  if(m.pending)return 'pending';
  if(m.error)return SCANNER_FAILURE_REASONS.get(m.error.trim().replace(/^(?:(?:Error|Erro|Exception):\s*)+/i,''))==='existing-call'?'duplicate':'error';
  if(m.result?.duplicate)return 'duplicate';
  if(m.result)return m.result.call||m.result.registradoEm?'success':'error';
  if(m.cameraPaused)return 'paused';
  return 'idle';
}
function scannerNoticeText(m,state){
  if(state==='pending')return E(m.pending);
  if(state==='paused')return 'Câmera pausada. Selecione Retomar câmera para voltar à leitura.';
  if(m.error)return E(m.error);
  if(state==='error')return 'O sistema não confirmou o registro. Tente novamente.';
  const result=m.result;
  if(!result)return m.mode==='live'?'Aproxime o QR Code do crachá.':'A imagem é lida no aparelho.';
  const schoolName=find('schools',result.schoolId)?.nome;
  const check=state==='success'?'<svg class="scanner-check" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" d="m5 12 4 4L19 6"/></svg>':'';
  const details=[result.studentName,result.badgeCode,schoolName,timeHuman(result.registradoEm)].filter(Boolean).join(' · ');
  return `<strong class="scanner-result-title">${check}${state==='duplicate'?'Embarque já registrado':'Embarque registrado'}</strong>${details?`<span>${E(details)}</span>`:''}`;
}
function scannerFrame(live){
  return `<div class="scanner-frame ${live?'scanner-live':''}">
    ${live?'<video id="qrVideo" playsinline autoplay muted aria-label="Prévia da câmera"></video><span class="scanner-target" aria-hidden="true"></span>':`<div class="scanner-emblem">${icon('qr')}</div><span>Posicione o QR Code do crachá no centro</span>`}
  </div>`;
}
function scannerActionLabel(m,live){
  if(m.cameraPaused)return 'Retomar câmera';
  return m.cameraWindow?'Voltar ao leitor':live||m.photoOnly?'Tirar foto':m.result?'Ler próximo':'Abrir leitor ao vivo';
}
function scannerActionType(m,live){return !m.cameraPaused&&(live||m.photoOnly)?'scanPhoto':'scanNext';}
function scannerActions(m,live){
  const busy=m.pending?'disabled':'';
  return `<div class="scanner-actions">
    <button type="button" class="btn primary" id="scannerAction" data-act="${scannerActionType(m,live)}" ${busy}>${scannerActionLabel(m,live)}</button>
    ${m.cameraWindow||m.cameraPaused||!live&&!m.photoOnly?`<button type="button" class="btn" data-act="scanPhoto" ${busy}>Tirar foto</button>`:''}
    <button type="button" class="btn" data-act="scanFile" ${busy}>Escolher foto</button>
  </div>`;
}
function scannerDialog(m){
  const live=m.mode==='live'&&!m.cameraWindow;
  const state=scannerNoticeState(m);
  return `<div class="scanner-body">
    ${scannerFrame(live)}
    <div id="scannerNotice" class="scanner-notice" data-state="${state}" role="status" aria-atomic="true" tabindex="-1">
      ${m.cameraWindow?'Leitor aberto em outra aba.':scannerNoticeText(m,state)}
    </div>
    <input id="scannerCapture" type="file" accept="image/*" capture="environment" hidden>
    <input id="scannerFile" type="file" accept="image/*" hidden>
    ${scannerActions(m,live)}
    ${disclosure('scanner-'+m.mode,'Digitar código do crachá',
      `<form id="modalForm" data-form="scannerCode"><label for="scannerCode">Código do crachá</label><input class="control" id="scannerCode" name="code" placeholder="RC-7K9P-4M2A" value="${E(m.typed)}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" required><button class="btn" type="submit" ${m.pending?'disabled aria-busy="true"':''}>Registrar</button></form>`,
      {id:'scannerManual',className:'scanner-manual',open:Boolean(m.typed&&m.error)})}
  </div>`;
}
function modalHtml(){const m=S.modal;if(!m)return '';let body='',title='',sub='',submit='Salvar alterações';
  if(m.type==='password'){title='Alterar senha';sub=m.mandatory?'Por segurança, escolha uma senha individual para continuar.':'Atualize sua senha de acesso.';body=`<form id="modalForm" data-form="password">${field('current','Senha atual','','Senha atual','type="password" required autocomplete="current-password"')}${field('next','Nova senha (mínimo 12 caracteres)','','Nova senha','type="password" minlength="12" required autocomplete="new-password"')}${field('confirm','Confirme a nova senha','','Repita a nova senha','type="password" minlength="12" required autocomplete="new-password"')}${modalActions(m.mandatory)}</form>`;}
  else if(m.type==='replaceBadge'){
    title='Substituir crachá perdido';sub=val('students',m.id);
    body=`<form id="modalForm" data-form="replaceBadge"><p>Crachá atual <strong>${E(m.currentCode)}</strong></p><p>O código e o QR antigos serão cancelados. O novo crachá terá outro código. As chamadas já registradas serão preservadas.</p>${modalActions(false,'Cancelar antigo e emitir novo')}</form>`;
  }
  else if(m.type==='year'){
title='Novo ano letivo';sub='Os estudantes antigos permanecem no histórico. Cadastre turmas, rotas e estudantes para o novo ano.';body=`<form id="modalForm" data-form="year">${field('year','Ano letivo',String(Number(S.year)+1),'Ex.: 2027','pattern="20[0-9]{2}" required')}${modalActions()}</form>`;}
  else if(m.type==='assign'){title='Vincular rotas';sub=val('users',m.id);body=assignmentDialog(m);}
  else if(m.type==='monitorSetup'){title='Configurar Leites e Simão';sub='Monitoras e pontos de referência · 2026';body=monitorSetupDialog(m);}
  else if(m.type==='mergeRoutes'){title='Unificar rotas';sub='Rota principal · '+routeLabel(find('routes',m.id));body=mergeRoutesDialog(m);}
  else if(m.type==='absence'){title='Motivo da ausência';sub=m.alert.nome;body=absenceDialog(m);}
  else if(m.type==='routeDay'){title=m.closed?'Reabrir dia da rota':'Encerrar dia da rota';sub=val('routes',m.routeId)+' · '+dateHuman(m.day);body=routeDayDialog(m);}
  else if(m.type==='scanner'){title=DIRECTION[m.direction];sub=val('routes',m.routeId)+' · '+dateHuman(m.day);body=scannerDialog(m);}
  else if (m.type === 'studentImport') {
    title = m.result ? 'Importação concluída' : m.preview ? 'Confira a importação' : 'Importar estudantes';
    sub = `Ano letivo ${m.year}`;
    body = studentImportForm(m);
  }
  else{const type=m.type,item=m.draft||{},edit=!!m.id;title=(edit?'Editar ':'Cadastrar ')+TYPE[type].toLowerCase();sub=type==='user'?'Defina as permissões do e-mail cadastrado no Supabase.':'Os dados serão salvos e atualizados nos demais acessos.';submit=edit?'Salvar alterações':'Cadastrar';
    const schools=a('schools'), schoolId=role()==='escola'?user().escolaId:item.escolaId||'';
    const routeId=item.rotaId||'';
    const routes=a('routes').filter(route=>(!schoolId||routeSchoolIds(route).includes(schoolId))&&(isActive(route)||route.id===routeId));
    const points=a('stops').filter(point=>point.rotaId===routeId&&(isActive(point)||point.id===item.pontoId)).sort(compareStops);
    if(type==='student'&&role()==='monitor'&&edit&&!canManageStudent(find('students',m.id))){
      const original=find('students',m.id);
      const linked=Boolean(original?.rotaId);
      const moving=linked&&routeId!==original.rotaId;
      title=linked?'Alterar rota ou ponto':'Vincular estudante à rota';
      sub=linked?'Corrija o ponto de embarque ou transfira o estudante para outra rota autorizada.':'Selecione uma rota autorizada. O ponto pode ser informado depois.';
      const guidance=moving
        ?'<p class="tip">Ao transferir a rota, o histórico das chamadas e o QR Code do estudante serão preservados.</p>'
        :'<p class="tip">Só aparecem rotas atribuídas ao seu acesso e que atendem à escola do estudante.</p>';
      body=`<form id="modalForm" data-form="student"><div class="tip"><b>${E(item.nome)}</b><div>${E(val('schools',item.escolaId))}</div></div>${selectField('rotaId','Rota do estudante',routes,item.rotaId,'Escolha a rota','required data-cascade="yes"')}${selectField('pontoId','Ponto de embarque',points,item.pontoId,'A definir')}${guidance}${modalActions()}</form>`;
    }else{
      if(type==='school')body=field('nome','Nome da escola',item.nome,'Ex.: Escola Municipal…','required maxlength="140"');
      if(type==='class')body=(role()==='secretaria'?selectField('escolaId','Escola',schools,schoolId,'Selecione a escola','required'):'')+field('nome','Nome da turma',item.nome,'Ex.: 5º ano A','required maxlength="140"');
      if(type==='route'){
        body=field('nome','Nome da rota',item.nome,'Ex.: Rota Rural 01','required maxlength="140"')+
          field('veiculo','Veículo',item.veiculo,'Ex.: Ônibus 02','maxlength="140"')+
          field('motorista','Motorista',item.motorista,'Nome do motorista','maxlength="140"');
        if(role()==='secretaria')body+=routeSchoolFields(item.escolaIds||[]);
      }
      if(type==='stop'){
        const editableRoutes=a('routes').filter(route=>canEditRoute(route)&&(isActive(route)||route.id===routeId));
        body=selectField('rotaId','Rota',editableRoutes,item.rotaId,'Selecione uma rota','required')+field('nome','Nome do ponto',item.nome,'Ex.: Fazenda Boa Vista','required')+field('ordem','Ordem do ponto',item.ordem||'1','Número','type="number" min="1" max="999"');
      }
      if (type === 'student') {
        const shifts = item.turnos ?? [];
        const shiftField = `<fieldset class="assignment-field">
          <legend>Turno</legend>
          ${STUDENT_SHIFTS.map(([value,label])=>`<label class="check-row"><input type="checkbox" name="turnos" value="${value}" ${shifts.includes(value)?'checked':''}> ${label}</label>`).join('')}
        </fieldset>`;
        const identification = (role() !== 'escola' ? selectField('escolaId', 'Escola', schools, schoolId, 'A definir', 'data-cascade="yes"') : '')
          + field('nome', 'Nome completo do estudante', item.nome, 'Nome e sobrenome', 'required maxlength="140"')
          + shiftField;
        const transport = selectField('rotaId', 'Rota', routes, item.rotaId, 'A definir', 'data-cascade="yes"')
          + field('logradouro', 'Logradouro', item.logradouro, 'Rua, avenida ou localidade', 'maxlength="200"')
          + selectField('pontoId', 'Ponto', points, item.pontoId, 'A definir');
        const contacts = field('nomeMae', 'Nome completo da mãe', item.nomeMae, 'Nome e sobrenome', 'maxlength="140"')
          + field('nomePai', 'Nome completo do pai', item.nomePai, 'Nome e sobrenome', 'maxlength="140"')
          + field('responsavel', 'Responsável', item.responsavel, 'Nome do responsável', 'maxlength="140"')
          + field('celular', 'Celular do responsável', item.celular, '(38) 99999-9999', 'type="tel" maxlength="140"');
        body=adminForm()?formSection('Identificação escolar',identification)+formSection('Transporte',transport)+formSection('Família e contato',contacts):identification+transport+contacts;
      }
      if(type==='user')body=field('nome','Nome completo',item.nome,'Nome do usuário','required')
        +field('email','E-mail cadastrado',item.email,'voce@exemplo.com','type="email" maxlength="254" required autocapitalize="none"'+(edit&&item.email?' readonly':''))
        +`<div class="field"><label for="f_perfil">${fieldLabel('Perfil de acesso','required')}</label><select name="perfil" id="f_perfil" data-cascade="yes" required><option value="secretaria" ${item.perfil==='secretaria'?'selected':''}>Secretaria</option><option value="escola" ${item.perfil==='escola'?'selected':''}>Escola</option><option value="monitor" ${item.perfil==='monitor'?'selected':''}>Monitor</option></select></div>`
        +(item.perfil==='escola'?selectField('escolaId','Escola',schools,item.escolaId,'Selecione uma escola','required'):'')
        +(edit?`<div class="field"><label for="f_ativo">Situação</label><select id="f_ativo" name="ativo"><option value="SIM" ${isActive(item)?'selected':''}>Ativo</option><option value="NAO" ${!isActive(item)?'selected':''}>Inativo</option></select></div>`:'')
        +`<div class="tip">Use o e-mail de uma conta já criada no Authentication do Supabase. Aqui você define o perfil e as permissões. A senha é a mesma dessa conta.</div>`;
      const requirements=type==='student'?'<p class="form-requirements">Só o nome completo é obrigatório. Os demais dados podem ser preenchidos depois.</p>':adminForm()?'<p class="form-requirements">Campos com * são obrigatórios.</p>':'';
      body=`<form id="modalForm" data-form="${E(type)}"${adminForm()?' class="admin-form"':''}>${requirements}<div class="form-grid">${body}</div>${modalActions(false,submit)}</form>`;
    }
  }
  return `<div class="modal-mask" data-act="overlay"><div class="modal ${m.type==='studentImport'?'import-modal':['scanner','absence','routeDay','assign','monitorSetup'].includes(m.type)?'transport-modal':''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><div><h2 id="modalTitle" tabindex="-1">${E(title)}</h2><p>${E(sub)}</p></div>${m.mandatory?'':`<button class="icon-btn" data-act="closeModal" type="button" aria-label="Fechar">${icon('close')}</button>`}</div>${body}</div></div>`;
}
function modalActions(mandatory=false,label='Salvar alterações'){return `<div class="modal-actions">${mandatory?'<button class="btn ghost" type="button" data-act="logout">← Voltar ao login</button>':'<button class="btn" type="button" data-act="closeModal">Cancelar</button>'}<button class="btn primary" type="submit" ${S.busy?'disabled aria-busy="true"':''}>${S.busy?'Salvando…':label}</button></div>`;}
function csvCell(value){
  const text=String(value===undefined?'':value);
  const needsLiteral=/^[\s\u200b-\u200f\u2060]*[\t\r\n=+@\-＝＋＠－]/u.test(text);
  const safe=needsLiteral?"'"+text:text;
  return '"'+safe.replace(/"/g,'""')+'"';
}
function exportCSV(what){let headers=[],rows=[];
  if(what==='students'){
    const showAddress = canEdit();
    headers=['Estudante','Código do crachá','Escola','Turma','Rota','Ponto','Responsável','Celular','Ano'];
    if (showAddress) headers.push('Logradouro');
    rows=filteredStudents().map(s=>[s.nome,s.crachaCodigo||'',val('schools',s.escolaId),val('classes',s.turmaId),val('routes',s.rotaId),val('stops',s.pontoId),s.responsavel,s.celular,s.ano,...(showAddress?[s.logradouro||'']:[])]);
  }
  else if(what==='calls'){
    headers=['Estudante','Escola','Rota','Ponto','Data','Sentido','Situação','Registrado em','Origem'];
    const route=find('routes',S.route);
    const {calls,schoolOf,items}=attendanceRoster(route);
    rows=schoolGroups(items,schoolOf).flatMap(([schoolId,students])=>students.map(student=>{
      const call=calls.get(student.id);
      return [student.nome,val('schools',schoolId),route.nome,val('stops',call?call.pontoId:student.pontoId),S.day,S.sentido,
        call?.status||'PENDENTE',call?.registradoEm||'',call?.origem||''];
    }));
  }
  else if(what==='routesSummary'){
    const summary=routeSummary();
    const schoolColumns=a('schools').filter(school=>summary.some(row=>routeSchoolIds(row.route).includes(school.id)));
    headers=['Rota','Total de estudantes ativos','Pontos',...schoolColumns.map(school=>school.nome)];
    rows=summary.map(({route,schools,total,points})=>[route.nome,total,points,
      ...schoolColumns.map(column=>schools.find(school=>school.id===column.id)?.count??'')]);
  }
  else if(what==='routes'){
    headers=['Rota','Ano letivo','Escolas atendidas','Motorista','Veículo'];
    rows=a('routes').map(route=>[route.nome,route.ano,routeSchoolNames(route),route.motorista,route.veiculo]);
  }
  else if(what==='users'){headers=['Nome','E-mail','Perfil','Escola','Situação'];rows=a('users').map(u=>[u.nome,u.email||'',u.perfil,val('schools',u.escolaId),u.ativo]);}
  else{const cols={schools:['nome'],classes:['nome','ano','escolaId'],stops:['nome','rotaId','ordem']}[what];if(!cols)return;headers=cols;rows=a(what).map(x=>cols.map(c=>c==='escolaId'?val('schools',x[c]):c==='rotaId'?val('routes',x[c]):x[c]));}
  const text='\ufeff'+[headers,...rows].map(row=>row.map(csvCell).join(';')).join('\r\n');
  const link=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8;'}));link.href=url;link.download='Rotas_Carbonita_'+what+'_'+S.year+'.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function badgeDocument(student,qr,{school,route,stop}){
  const firstName=String(student.nome||'').trim().split(/\s+/)[0];
  const fields=[
    ['Nome completo',student.nome],['Mãe',student.nomeMae],['Pai',student.nomePai],
    ['Endereço',student.logradouro],['Telefone',student.celular]
  ];
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crachá escolar</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:20px;font:14px Arial,sans-serif;color:#173756;background:#f5f8fc}
  main{display:flex;justify-content:center;flex-wrap:wrap;gap:20px}
  section{max-width:100%;text-align:center}
  .caption{margin:0 0 8px;color:#475f75;font-size:13px;font-weight:bold}
  .card{width:90mm;max-width:100%;min-height:135mm;padding:7mm;border:1px solid #b8cadd;border-radius:4mm;background:white;overflow-wrap:anywhere}
  h1,h2,p{margin:0}
  h1{font-size:19px;margin-bottom:10px}
  small{font-size:11px;color:#475f75}
  .school{margin-top:8px}
  svg{display:block;width:49mm;height:49mm;margin:14px auto 7px;max-width:100%}
  .first-name{font-size:20px;font-weight:bold}
  .badge-code{font-size:15px;font-weight:bold;margin:4px 0 12px}
  .routes{font-size:12px;margin-bottom:12px}
  .notice{font-size:11px;margin-top:8px}
  .back{text-align:left}
  .back h2{text-align:center;font-size:18px;margin-bottom:18px}
  dl{margin:0}
  dl div{padding-bottom:6px;margin-bottom:10px;border-bottom:1px solid #b8cadd;break-inside:avoid}
  dt{font-size:11px;font-weight:bold;color:#475f75}
  dd{margin:4px 0 0;min-height:1em;font-size:13px}
  footer{text-align:center}
  button{padding:10px 20px;margin:18px 0 8px;border:0;border-radius:9px;background:#175fba;color:white;cursor:pointer}
  footer p{font-size:12px;color:#475f75}
  @page{size:A4 portrait;margin:12mm}
  @media print{
    body{padding:0;background:white}
    main{display:block}
    section{break-inside:avoid}
    section+section{break-before:page}
    .card{margin:0 auto;border-color:#778da3}
    .caption,footer{display:none}
  }
</style></head><body>
<main>
  <section aria-label="Frente do crachá">
    <p class="caption">Frente do crachá</p>
    <div class="card">
      <h1>TRANSPORTE ESCOLAR</h1>
      <small>REDE MUNICIPAL · CARBONITA/MG</small>
      <p class="school">${E(school)}</p>
      ${qr}
      <p class="first-name">${E(firstName)}</p>
      <p class="badge-code">${E(student.crachaCodigo)}</p>
      <p class="routes"><b>Rota:</b> ${E(route)}<br><b>Ponto:</b> ${E(stop)}</p>
      <small>Uso exclusivo no transporte escolar</small>
      <p class="notice">Encontrou este crachá? Entregue à escola ou à Secretaria de Educação.</p>
    </div>
  </section>
  <section aria-label="Verso do crachá">
    <p class="caption">Verso do crachá</p>
    <div class="card back">
      <h2>Dados pessoais</h2>
      <dl>${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${E(String(value??'').trim()||'—')}</dd></div>`).join('')}</dl>
    </div>
  </section>
</main>
<footer>
  <button type="button" onclick="window.print()">Imprimir crachá</button>
  <p>Para imprimir frente e verso, selecione a opção de virar pela borda longa.</p>
</footer>
</body></html>`;
}
async function printBadge(id){
  const s=find('students',id);
  if(!s||!canManageStudent(s)||!s.qrToken||!s.crachaCodigo){message('Crachá indisponível para este acesso. Atualize os dados e confira o vínculo do estudante.',true);return;}
  const win=window.open('','_blank','width=465,height=700');
  if(!win){message('Permita janelas para imprimir o crachá.',true);return;}
  const token=S.token;
  try{
    await window.loadRotasAsset('QRCodeVendor');
    if(win.closed)return;
    if(S.token!==token){win.close();return;}
    const svg=window.makeQrSvg('TC:'+s.qrToken);
    const html=badgeDocument(s,svg,{
      school:val('schools',s.escolaId),route:val('routes',s.rotaId),stop:val('stops',s.pontoId)
    });
    win.document.open();
    win.document.write(html);
    win.document.close();
  }catch(e){
    win.close();
    throw e;
  }
}
function openModal(type,id,trigger){
  if(role()==='monitor'){
    if(type!=='student')return;
    const student=id?find('students',id):null;
    if(id?(!isActive(student)||(student.rotaId&&!canManageStudent(student))):!canManageStudent())return;
  }
  stopCamera();const key={student:'students',school:'schools',class:'classes',route:'routes',stop:'stops',user:'users'}[type];const old=id?find(key,id):null;
  const draft=old?{...old}:{};if(type==='user'&&!id)draft.perfil='monitor';if(type==='student'&&role()==='escola')draft.escolaId=user().escolaId;
  if(type==='student'&&!id&&role()==='monitor'){
    const routes=a('routes').filter(isActive);
    if(routes.length===1)draft.rotaId=routes[0].id;
  }
  if(type==='route'&&!id){const schools=importSchools();draft.escolaIds=schools.length===1?[schools[0].id]:[];}
  S.modal={type,id:id||null,draft,returnAction:trigger?.dataset.act};render();}
function formData(form){return Object.fromEntries(new FormData(form).entries());}
function openStudentImport() {
  if (!canEdit() || S.busy) return;
  const schools = importSchools();
  const filtered = schools.find(school => school.id === S.filters.school);
  const schoolId = role() === 'escola' ? user().escolaId : filtered?.id || (schools.length === 1 ? schools[0].id : '');
  S.modal = { type: 'studentImport', year: S.year, escolaId: schoolId };
  render();
  window.loadRotasAsset('ImportXlsx').catch(()=>{});
  ($('f_escolaId') || $('studentWorkbook'))?.focus();
}
async function submitStudentImport(form, m) {
  if (S.busy || !canEdit() || m?.type !== 'studentImport' || m.result) return;
  const file = $('studentWorkbook')?.files[0];
  m.error = '';
  if (!m.preview && role() === 'secretaria') m.escolaId = form.elements.escolaId.value;
  S.busy = true;
  render();
  try {
    if (!m.preview) {
      await window.loadRotasAsset('ImportXlsx');
      const workbook = await window.readStudentWorkbook(file);
      m.fileName = file.name;
      m.sheetName = workbook.sheetName;
      m.payload = { escolaId: m.escolaId, year: m.year, rows: workbook.rows };
    }
    const result = await api('importStudents', { ...m.payload, confirmation: m.preview?.confirmation || '' });
    if (result.saved) {
      m.result = result;
      m.payload = null;
      m.preview = null;
      await load();
    } else {
      m.preview = result;
    }
  } catch (error) {
    m.error = error.message || 'Falha na importação.';
    if (/Sessão expirada|Sessão inválida|Usuário desativado/.test(m.error)) warn(error);
  } finally {
    S.busy = false;
    render();
    if (S.modal === m) ($('importSummary') || $('studentWorkbook'))?.focus();
  }
}
async function mutate(action,data,msg='Alterações salvas com sucesso.',onError=warn){
  if(S.busy)return;S.busy=true;
  try{
    const res=await api(action,data);
    if(S.modal){
      await dismissDialog();
      render();
      $('conteudo')?.focus({preventScroll:true});
    }
    S.busy=false;await load();
    const feedback=res.studentName?res.studentName+' · '+(res.status==='PRESENTE'?'Presente':'Ausente'):msg;
    if(feedback)message(feedback);
    return res;
  }
  catch(e){S.busy=false;onError(e);render();return null;}}
function studentSaveError(error){
  const detail=error.message||'';
  if(sessionEnded(detail)){warn(error);return;}
  const form=$('modalForm');
  if(S.modal?.type==='student'&&form?.dataset.form==='student'){
    Object.assign(S.modal.draft,formData(form));
    if(form.elements.namedItem('turnos'))S.modal.draft.turnos=new FormData(form).getAll('turnos');
  }
  const known=error.code==='P0001'||error.code==='42501'||detail==='Sem conexão com o sistema. Confira a internet e tente novamente.';
  message(known?detail:'Não foi possível salvar o estudante. Confira a conexão e tente novamente.',true);
}
function saveStudentForm(form,payload,feedback){
  const submit=form.querySelector('button[type="submit"]');
  submit.disabled=true;
  submit.setAttribute('aria-busy','true');
  submit.textContent='Salvando…';
  return mutate('save',payload,feedback,studentSaveError);
}
async function registerCall(payload){return mutate('attendance',{day:S.day,sentido:S.sentido,routeId:S.route,...payload},'Chamada registrada.');}
async function dismissDialog(){
  stopCamera();
  S.modal=null;
  const mask=document.querySelector('.modal-mask');
  if(!mask||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const dialog=mask.querySelector('.modal');
  // Continue from the current appearance if the opening animation is interrupted.
  const maskStyle=getComputedStyle(mask);
  const dialogStyle=getComputedStyle(dialog);
  mask.style.setProperty('--dialog-backdrop-opacity',maskStyle.opacity);
  dialog.style.setProperty('--dialog-opacity',dialogStyle.opacity);
  dialog.style.setProperty('--dialog-transform',dialogStyle.transform);
  closingDialog=true;
  mask.inert=true;
  mask.classList.add('is-closing');
  const animations=[...mask.getAnimations(),...dialog.getAnimations()];
  await Promise.allSettled(animations.map(animation=>animation.finished));
  closingDialog=false;
}
async function closeModal(){
  const m=S.modal;
  if(!m||m.mandatory||(m.pending&&m.type!=='scanner')||S.busy)return;
  await dismissDialog();
  render();
  if (m.returnAction) {
    const trigger = Array.from(document.querySelectorAll('[data-act][data-type]')).find(button =>
      button.dataset.act === m.returnAction && button.dataset.type === m.type &&
      (button.dataset.id || null) === m.id
    );
    trigger?.focus({preventScroll:true});
  }
  if(m.type==='studentImport')document.querySelector('[data-act="studentImport"]')?.focus();
  if(m.type==='scanner'){
    document.querySelector(`[data-act="scan"][data-direction="${m.direction}"]`)?.focus();
    refresh();
  }
  if(m.type==='absence'){
    const button=Array.from(document.querySelectorAll('[data-act="absence"]')).find(item=>item.dataset.id===m.alert.id);
    const history=button?.closest('details');
    if(history){history.open=true;syncDisclosure(history);}
    button?.focus();
    refresh();
  }
  if(m.type==='routeDay')document.querySelector('[data-act="routeDay"]')?.focus();
  if(m.type==='mergeRoutes')Array.from(document.querySelectorAll('[data-act="mergeRoutes"]')).find(button=>button.dataset.id===m.id)?.focus();
  if(m.type==='password')document.querySelector(S.view==='profile'?'.monitor-profile [data-act="password"]':'.topright [data-act="password"]')?.focus();
  if(document.activeElement===document.body)$('conteudo')?.focus({preventScroll:true});
}
async function changePassword(form){const d=formData(form);if(d.next!==d.confirm){message('A confirmação não corresponde à nova senha.',true);return;}
  if(S.busy)return;S.busy=true;try{const r=await api('changePassword',d);if(S.data)S.data.user=r.user;if(S.modal)await dismissDialog();S.busy=false;await load(true);message('Sua senha foi atualizada.');}catch(e){S.busy=false;warn(e);render();}}
function logout(){
  stopCamera();
  api('logout').catch(()=>{});
  ++loadRequest;
  S.token='';S.data=null;S.modal=null;S.loading=false;S.loadingVisible=false;S.loadError='';S.menu=false;S.callSchool='';S.callStop='';
  STORE.remove('rc_session');
  render();
}
function canUseLiveCamera(view=window){
  const policy=view.document.permissionsPolicy||view.document.featurePolicy;
  return Boolean(view.navigator.mediaDevices?.getUserMedia&&
    (policy?.allowsFeature?.('camera')??view===view.top));
}
const QR_SCANNER_URL='';
function openScanner(direction){
  const day=S.view==='attendance'?S.day:todayLocal();
  const route=find('routes',S.route);
  if(!DIRECTION[direction]||!canManageDay(route,day)||day!==todayLocal())return;
  S.sentido=direction;
  S.modal={type:'scanner',routeId:route.id,direction,day,useLive:canUseLiveCamera()};
  nextScan();
}
function nextScan(photo=false){
  const m=S.modal;
  if(m?.type!=='scanner'||m.pending)return;
  if(!photo&&m.cameraPaused){
    if(document.hidden)return;
    m.cameraPaused=false;
    m.error='';
    m.result=null;
    updateScanner(m);
    $('scannerAction')?.focus({preventScroll:true});
    startLiveCamera(m);
    return;
  }
  if(!photo&&m.cameraWindow&&!m.cameraWindow.closed){m.cameraWindow.focus();return;}
  stopCamera();
  m.cameraPaused=false;
  m.mode=!photo&&m.useLive?'live':'photo';
  m.error='';
  m.result=null;
  m.typed='';
  if(!photo&&!m.useLive&&!m.photoOnly){openLiveCameraTab(m);return;}
  render();
  $('scannerAction').focus();
  if(m.mode==='live')startLiveCamera(m);
  else if(photo)$('scannerCapture').click();
}
function chooseScanPhoto(){
  const m=S.modal;
  if(m?.type!=='scanner'||m.pending)return;
  stopCamera();
  m.cameraPaused=false;
  m.mode='photo';
  render();
  $('scannerFile').click();
}
function decodeFrame(source,width,height,canvas,limit){
  const scale=Math.min(1,limit/Math.max(width,height));
  const targetWidth=Math.max(1,Math.round(width*scale));
  const targetHeight=Math.max(1,Math.round(height*scale));
  if(canvas.width!==targetWidth)canvas.width=targetWidth;
  if(canvas.height!==targetHeight)canvas.height=targetHeight;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(source,0,0,canvas.width,canvas.height);
  const pixels=context.getImageData(0,0,canvas.width,canvas.height);
  return window.jsQR(pixels.data,pixels.width,pixels.height)?.data?.trim()||'';
}
function openLiveCameraTab(m){
  try{
    if(!QR_SCANNER_URL){cameraFallback(m,'O leitor ao vivo está indisponível. Use uma foto do crachá.');return;}
    const url=new URL(QR_SCANNER_URL);
    if(url.protocol!=='https:')throw Error('O leitor precisa de um endereço HTTPS.');
    const channel=Array.from(window.crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
    url.hash=new URLSearchParams({channel}).toString();
    const tab=window.open(url.href,'_blank');
    if(!tab){cameraFallback(m,'O navegador bloqueou a abertura do leitor. Permita a nova aba ou use uma foto do crachá.');return;}
    m.cameraWindow=tab;
    m.mode='live';
    const reader={connected:false,request:0,lastRequest:0,send(type,data={}){
      tab.postMessage({type,channel,...data},url.origin);
    }};
    m.reader=reader;
    reader.receive=event=>{
      if(S.modal!==m||m.cameraWindow!==tab)return;
      const data=event.data;
      if(event.source!==tab||event.origin!==url.origin||data?.channel!==channel)return;
      if(data.type==='rotas-qr:ready'){
        window.clearTimeout(reader.timeout);
        reader.connected=true;
        reader.send('rotas-qr:connected');
        return;
      }
      if(!reader.connected)return;
      if(data.type==='rotas-qr:close'){
        stopCamera();
        m.mode='photo';
        render();
        $('scannerAction')?.focus();
        return;
      }
      if(data.type!=='rotas-qr:read'||!Number.isSafeInteger(data.request)||data.request<=reader.lastRequest||typeof data.code!=='string'||data.code.length>200)return;
      if(m.pending){reader.send('rotas-qr:result',{request:data.request,status:'error'});return;}
      reader.request=reader.lastRequest=data.request;
      saveScan(m,data.code);
    };
    window.addEventListener('message',reader.receive);
    reader.timeout=window.setTimeout(()=>{
      if(S.modal===m&&m.reader===reader&&!reader.connected)cameraFallback(m,'Não foi possível conectar ao leitor ao vivo. Abra o leitor novamente ou use uma foto.');
    },14000);
    render();
  }catch(e){stopCamera();cameraFallback(m);}
}
async function startLiveCamera(m){
  if(S.modal!==m||m.live||document.hidden)return;
  const live={stream:null,timer:null};
  m.live=live;
  const reader=window.loadRotasAsset('QRReader');
  reader.catch(()=>{});
  const isCurrent=()=>S.modal===m&&m.live===live;
  try{
    m.error='';
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    if(!isCurrent()){stream.getTracks().forEach(track=>track.stop());return;}
    live.stream=stream;
    const video=$('qrVideo');
    video.srcObject=stream;
    await video.play();
    if(!isCurrent())return;
    try{await reader;}
    catch(e){if(isCurrent())cameraFallback(m,e.message);return;}
    if(!isCurrent())return;
    const canvas=document.createElement('canvas');
    updateScanner(m);
    let lastCode='', clearFrames=0;
    live.timer=setInterval(()=>{
      if(!isCurrent()||m.pending||document.hidden||$('scannerManual')?.open||video.readyState<2||!video.videoWidth)return;
      try{
        const code=decodeFrame(video,video.videoWidth,video.videoHeight,canvas,900);
        if(!code){
          if(++clearFrames>=3)lastCode='';
          return;
        }
        clearFrames=0;
        if(code===lastCode)return;
        lastCode=code;
        saveScan(m,code);
      }catch(e){cameraFallback(m);}
    },400);
  }catch(e){
    if(isCurrent())cameraFallback(m);
  }
}
function cameraFallback(m,error){
  stopCamera();
  m.useLive=false;
  m.photoOnly=!QR_SCANNER_URL;
  m.mode='photo';
  m.result=null;
  m.error=error||'A câmera ao vivo não abriu no painel. Abra o leitor ao vivo ou escolha uma foto do crachá.';
  if(!$('scannerNotice')){
    render();
    $('scannerNotice')?.focus({preventScroll:true});
  }else updateScanner(m);
}
function stopCamera(){
  const m=S.modal;
  if(!m)return;
  if(m.live){
    clearInterval(m.live.timer);
    m.live.stream?.getTracks().forEach(track=>track.stop());
    m.live=null;
    const video=$('qrVideo');
    if(video)video.srcObject=null;
  }
  if(m.reader){
    window.removeEventListener('message',m.reader.receive);
    window.clearTimeout(m.reader.timeout);
    m.reader=null;
  }
  const cameraWindow=m.cameraWindow;
  if(cameraWindow){
    m.cameraWindow=null;
    if(!cameraWindow.closed)cameraWindow.close();
  }
}
function pauseLiveCamera(){
  const m=S.modal;
  if(m?.type!=='scanner'||!m.live)return;
  stopCamera();
  m.cameraPaused=true;
  if($('scannerNotice'))updateScanner(m);
}
async function readPhoto(file){
  await window.loadRotasAsset('QRReader');
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();
    await new Promise((resolve,reject)=>{
      image.onload=resolve;
      image.onerror=()=>reject(Error('Não foi possível abrir a foto. Tire outra foto do crachá.'));
      image.src=url;
    });
    return decodeFrame(image,image.naturalWidth,image.naturalHeight,document.createElement('canvas'),1600);
  }finally{
    URL.revokeObjectURL(url);
  }
}
async function scanPhoto(file){
  const m=S.modal;
  if(!file||m?.type!=='scanner'||m.pending)return;
  stopCamera();
  m.cameraPaused=false;
  m.mode='photo';
  m.pending='Lendo o crachá…';
  m.result=null;
  m.error='';
  updateScanner(m);
  try{
    const code=await readPhoto(file);
    if(S.modal===m)await saveScan(m,code);
  }catch(e){
    if(S.modal===m){m.pending='';m.error=e.message;updateScanner(m);}
  }
}
const SCANNER_FAILURE_REASONS=new Map([
  ['Este crachá não pertence à rota selecionada.','wrong-route'],
  ['Este crachá não pertence a rota selecionada.','wrong-route'],
  ['Crachá não vinculado a um estudante ativo.','inactive-badge'],
  ['Este QR não é um crachá do Rotas Carbonita.','invalid-badge'],
  ['A leitura do crachá registra embarques na data de hoje.','wrong-day'],
  ['Selecione uma data válida, até hoje.','wrong-day'],
  ['Selecione uma rota ativa do ano letivo da chamada.','inactive-route'],
  ['Monitor não autorizado para esta rota.','route-access'],
  ['Apenas Monitor e Secretaria podem registrar o transporte.','route-access'],
  ['Já existe uma chamada para este estudante no mesmo dia e sentido.','existing-call']
]);
function updateScanner(m){
  const reader=m.reader;
  if(reader){
    if(reader.request&&!m.pending){
      const status=m.error?'error':m.result?.duplicate?'duplicate':'saved';
      const reason=m.error&&SCANNER_FAILURE_REASONS.get(m.error.trim().replace(/^(?:(?:Error|Erro|Exception):\s*)+/i,''));
      reader.send('rotas-qr:result',{request:reader.request,status,...(reason?{reason}:{})});
      reader.request=0;
    }
    return;
  }
  const notice=$('scannerNotice');
  const live=m.mode==='live';
  const frame=notice.previousElementSibling;
  if(live!==frame.classList.contains('scanner-live')){
    frame.outerHTML=scannerFrame(live);
  }
  if($('scannerAction').dataset.act!==scannerActionType(m,live)){
    const actions=$('scannerAction').parentElement;
    const focused=actions.contains(document.activeElement)?document.activeElement:null;
    actions.outerHTML=scannerActions(m,live);
    if(focused){
      const primary=$('scannerAction');
      const replacement=focused.id===primary.id?primary:
        [...primary.parentElement.children].find(button=>button.dataset.act===focused.dataset.act);
      (replacement||primary).focus({preventScroll:true});
    }
  }
  const state=scannerNoticeState(m);
  notice.dataset.state=state;
  notice.innerHTML=scannerNoticeText(m,state);
  notice.scrollTop=0;
  $('scannerAction').textContent=scannerActionLabel(m,live);
  const pending=Boolean(m.pending);
  for(const button of document.querySelectorAll('.scanner-body button')){
    button.disabled=pending;
  }
  $('modalForm').querySelector('button[type="submit"]').setAttribute('aria-busy',String(pending&&Boolean(m.typed)));
  if(!live&&!pending&&!$('scannerManual').contains(document.activeElement))notice.focus({preventScroll:true});
}
async function saveScan(m,code,typed=false){
  if(S.modal!==m||m.pending==='Registrando embarque…')return;
  if(typed){
    stopCamera();
    m.cameraPaused=false;
    m.mode='photo';
  }
  m.result=null;
  m.error='';
  if(typed&&/^RC[2-9A-HJ-NP-Z]{8}$/.test(badgeSearchKey(code)))code=badgeSearchKey(code).replace(/^RC(.{4})(.{4})$/,'RC-$1-$2');
  if((!code.startsWith('TC:')&&!(typed&&/^RC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(code)))||code.length<4||code.length>200){
    m.pending='';
    m.error=code?'Este QR não é um crachá do Rotas Carbonita.':'QR Code não encontrado. Enquadre o crachá e tente de novo.';
    updateScanner(m);
    return;
  }
  m.pending='Registrando embarque…';
  updateScanner(m);
  try{
    const result=await api('attendance',{day:m.day,routeId:m.routeId,sentido:m.direction,qr:code,typed});
    if(S.modal!==m)return;
    m.result=result;
    if(result.call?.data===S.data.day)S.data.calls=[...a('calls').filter(call=>call.id!==result.call.id),result.call];
  }catch(e){
    if(S.modal!==m)return;
    if(sessionEnded(e.message)){warn(e);return;}
    m.error=e.message;
  }finally{
    if(S.modal===m){m.pending='';updateScanner(m);}
  }
}
async function handleClick(e){const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,id=b.dataset.id,type=b.dataset.type;
  if(closingDialog||(S.modal&&S.busy))return;
  if (act === 'studentImport') { openStudentImport(); return; }
  if (act === 'resetStudentImport' && S.modal?.type === 'studentImport') {
    const { year, escolaId } = S.modal;
    S.modal = { type: 'studentImport', year, escolaId };
    render();
    $('studentWorkbook')?.focus();
    return;
  }
  if(act==='overlay'){if(e.target===b)await closeModal();return;}
  if(act==='menu'){S.menu=!S.menu;render();$('portalMenu')?.focus({preventScroll:true});return;}
  if(act==='nav'){
    if (b.dataset.view === S.view && !S.menu) return;
    stopCamera();S.view=b.dataset.view;S.menu=false;S.modal=null;
    const day=todayLocal();
    if(role()==='monitor'&&S.view==='dashboard'&&S.data.day!==day){
      S.day=day;load(true);
    }else render();
    window.scrollTo(0,0);$('conteudo')?.focus({preventScroll:true});return;
  }
  if(act==='todayCalls'){
    S.view='attendance';S.menu=false;S.day=todayLocal();load(true);
    window.scrollTo(0,0);$('conteudo')?.focus({preventScroll:true});return;
  }
  if(act==='refresh'){if(S.loading&&hasSnapshot())return;if(await load(true))message('Dados atualizados.');return;}
  if(act==='logout'){await logout();return;}
  if(act==='password'){S.modal={type:'password',mandatory:false};render();$('modalTitle')?.focus();return;}
  if(act==='new'){openModal(type,null,b);return;}
  if(act==='monitorSetup'){await openMonitorSetup();return;}
  if(act==='edit'){openModal(type,id,b);return;}
  if(act==='routeStudents'){
    S.filters={search:'',school:'',route:id,stop:''};S.view='students';S.menu=false;render();
    window.scrollTo(0,0);$('conteudo')?.focus({preventScroll:true});return;
  }
  if(act==='mergeRoutes'){
    if(role()!=='secretaria'||!isActive(find('routes',id)))return;
    S.modal={type:'mergeRoutes',id};render();$('f_secondaryId')?.focus();return;
  }
  if(act==='closeModal'){await closeModal();return;}
  if(act==='badge'){await printBadge(id);return;}
  if(act==='replaceBadge'){const student=find('students',id);if(!student||!canManageStudent(student)||!student.crachaCodigo||!isActive(student))return;stopCamera();S.modal={type:'replaceBadge',id,currentCode:student.crachaCodigo};render();return;}
  if(act==='assign'){
    const monitor=find('users',id);
    if(role()!=='secretaria'||monitor?.perfil!=='monitor'||!isActive(monitor))return;
    const routeIds=a('assignments').filter(item=>item.usuarioId===id).map(item=>item.rotaId);
    S.modal={type:'assign',id,routeIds};render();
    $('modalForm')?.querySelector('input,button')?.focus();
    return;
  }
  if(act==='absence'){
    const alert=a('absenceAlerts').find(item=>item.id===id);
    if(!alert)return;
    S.modal={type:'absence',alert,draftReason:alert.motivo};render();$('absenceReason')?.focus();return;
  }
  if(act==='routeDay'){
    const route=find('routes',S.route),day=b.dataset.day;
    if(!canManageDay(route,day))return;
    S.modal={type:'routeDay',routeId:route.id,day,closed:routeDayClosed(route.id,day)};
    render();
    $('modalForm')?.querySelector('button')?.focus();
    return;
  }
  if(act==='newYear'){S.modal={type:'year'};render();$('modalTitle')?.focus();return;}
  if(act==='print'){stopCamera();window.print();return;}
  if(act==='export'){exportCSV(b.dataset.what);return;}
  if(act==='resetFilters'){S.filters={search:'',school:'',route:'',stop:''};syncStudentFilters();updateStudentResults();return;}
  if(act==='disable'){
    if(!confirm('Desativar este registro? Estudantes e referências vinculadas poderão impedir a operação.'))return;
    await mutate('disable',{type,id},'Registro desativado.');return;
  }
  if(act==='mark'){await registerCall({studentId:id,status:b.dataset.status});return;}
  if(act==='scan'){openScanner(b.dataset.direction);return;}
  if(act==='scanNext'){nextScan();return;}
  if(act==='scanPhoto'){nextScan(true);return;}
  if(act==='scanFile'){chooseScanPhoto();return;}
}
async function handleSubmit(e){const form=e.target;e.preventDefault();
  if (S.busy || closingDialog || !form.isConnected) return;
  if(form.id==='loginForm'){
    if(S.busy)return;S.busy=true;const x=formData(form);render();
    try{
      const r=await api('login',x);
      S.token='authenticated';
      
      S.busy=false;
      if(r.user&&(r.user.trocarSenha==='SIM'||r.user.exigeTroca)){
        S.data={user:r.user};
        S.modal={type:'password',mandatory:true};
        render();
        return;
      }
      await load();
    }catch(err){
      S.busy=false;
      warn(err);
      render();
    }
    return;
  }
  if(form.id!=='modalForm')return;const what=form.dataset.form;
  if(what==='password'){await changePassword(form);return;}
  if (what === 'studentImport') { await submitStudentImport(form, S.modal); return; }
  const x=formData(form),m=S.modal;if(!m)return;
  if(what==='replaceBadge'){
    const student=find('students',m.id);
    if(!student||!canManageStudent(student))return;
    const result=await mutate('replaceBadge',{studentId:m.id,currentCode:m.currentCode},'Crachá antigo cancelado. Abra Crachá QR para imprimir o novo.');
    if(result){const student=find('students',m.id);if(student)Object.assign(student,{crachaCodigo:result.crachaCodigo,qrToken:result.qrToken});render();}
    return;
  }
  if(what==='monitorSetup'){
    m.routeIds=Object.fromEntries(m.plan.groups.map(group=>[group.key,x['route_'+group.key]]));
    m.schoolIds=Object.fromEntries(m.plan.groups.map(group=>[group.key,new FormData(form).getAll('schools_'+group.key)]));
    const missing=m.plan.groups.find(group=>!m.routeIds[group.key]&&!m.schoolIds[group.key].length);
    if(missing){message('Selecione as escolas atendidas pela rota '+missing.nome+'.',true);return;}
    const result=await mutate('setupMonitors',{year:m.year,routeIds:m.routeIds,schoolIds:m.schoolIds},'Rotas e pontos configurados: Elenice em Leites; Leticia e Carla em Simão.');
    if(result?.warnings?.length)message(result.warnings.join(' '),true);
    return;
  }
  if(what==='scannerCode'){
    if(m.pending)return;
    m.typed=x.code.trim();
    await saveScan(m,m.typed,true);
    return;
  }
  if(what==='routeDay'){
    const r=await mutate('setRouteDay',{routeId:m.routeId,day:m.day,closed:!m.closed},'');
    if(r&&r.closed&&a('absenceAlerts').some(item=>!item.motivo&&item.rotaId===m.routeId))$('absenceTitle')?.focus();
    return;
  }
  if(what==='absence'){
    m.draftReason=x.reason;
    const alert=m.alert;
    const r=await mutate('saveAbsence',{studentId:alert.estudanteId,routeId:alert.rotaId,start:alert.inicio,revision:alert.revisao,reason:x.reason},'Motivo registrado.');
    if(r)$('absenceTitle')?.focus();
    else $('absenceReason')?.focus();
    return;
  }
  if(what==='year'){if(!/^20\d{2}$/.test(x.year)){message('Ano inválido.',true);return;}const r=await mutate('createYear',{year:x.year},'Novo ano letivo criado.');if(r){S.year=x.year;await load();}return;}
  if(what==='assign'){
    syncAssignmentForm(form);
    if(m.routeIds.length>2)return;
    await mutate('setAssignments',{userId:m.id,routeIds:m.routeIds,year:S.year},'Rotas do monitor atualizadas.');
    return;
  }
  if(what==='mergeRoutes'){
    m.secondaryId=x.secondaryId;
    await mutate('mergeRoutes',{primaryId:m.id,secondaryId:x.secondaryId},'Rotas unificadas.');
    return;
  }
  if(what==='route'&&role()==='secretaria'){
    x.escolaIds=new FormData(form).getAll('escolaIds');
    if(!x.escolaIds.length){message('Selecione as escolas atendidas pela rota.',true);form.querySelector('input[name="escolaIds"]')?.focus();return;}
  }
  x.id=m.id||'';
  if(what==='student'&&S.data?.studentRegistrationVersion!==1){
    message('O cadastro de estudantes está aguardando uma atualização. Avise a Secretaria e tente novamente.',true);
    return;
  }
  if(what==='student'&&role()==='monitor'&&m.id&&!canManageStudent(find('students',m.id))){
    const student=find('students',m.id);
    if(!student)return;
    const routes=a('routes').filter(route=>isActive(route)&&routeSchoolIds(route).includes(student.escolaId));
    const allowed=routes.some(route=>route.id===x.rotaId);
    const point=a('stops').find(stop=>stop.id===x.pontoId&&stop.rotaId===x.rotaId&&isActive(stop));
    const sameInactivePoint=student.rotaId===x.rotaId&&student.pontoId===x.pontoId;
    if(!allowed||x.pontoId&&!point&&!sameInactivePoint){message('Selecione uma rota autorizada e, se informar um ponto, escolha um ponto dessa rota.',true);return;}
    m.draft={...m.draft,...x};
    const moved=student.rotaId!==x.rotaId;
    const changedPoint=student.pontoId!==x.pontoId;
    if(!moved&&!changedPoint){message('Nenhuma alteração foi feita.');await closeModal();return;}
    const feedback=moved?(student.rotaId?'Rota do estudante alterada.':'Estudante vinculado à rota.'):'Ponto de embarque atualizado.';
    await saveStudentForm(form,{type:'student',year:student.ano,item:{id:m.id,rotaId:x.rotaId,pontoId:x.pontoId}},feedback);
    return;
  }
  if(what==='student'){
    x.nome=x.nome?.trim();
    if(!x.nome){message('Informe o nome completo do estudante.',true);form.elements.nome?.focus();return;}
    x.turnos=new FormData(form).getAll('turnos');
    m.draft={...m.draft,...x};
    if(m.id){
      const previous=find('students',m.id);
      if(!previous)return;
      for(const [key,value] of Object.entries(x)){
        if(key==='id')continue;
        const original=previous[key];
        if(key==='turnos'?value.join(',')===(original||[]).join(','):value===String(original??''))delete x[key];
      }
    }
    for(const key of ['escolaId','rotaId','pontoId']){
      if(key in x)x[key]=x[key]||null;
    }
    if(role()==='escola')x.escolaId=user().escolaId;
    if(!m.id)m.requestId??=crypto.randomUUID();
    await saveStudentForm(form,{type:'student',year:S.year,item:x,...(m.requestId?{requestId:m.requestId}:{})},
      m.id?'Alterações salvas com sucesso.':'Estudante cadastrado.');
    return;
  }
  if(what==='route'||what==='class'){x.ano=S.year;if(role()==='escola')x.escolaId=user().escolaId;}
  if(what==='user'){if(m.id)x.id=m.id;await mutate('createUser',{item:x},'Usuário cadastrado ou atualizado.');return;}
  await mutate('save',{type:what,year:S.year,item:x});
}
function handleChange(e){const target=e.target,id=target.id;
  if(id==='scannerCapture'||id==='scannerFile'){
    const file=target.files[0];
    target.value='';
    scanPhoto(file).catch(warn);return;
  }
  if(S.modal?.type==='assign'&&target.name==='routeId'){syncAssignmentForm($('modalForm'));return;}
  if(id==='yearSelect'){stopCamera();S.year=target.value;S.filters={search:'',school:'',route:'',stop:''};S.route='';S.callSchool='';S.callStop='';load(true);return;}
  if(id==='filterSchool'){
    const schoolId=target.value;
    S.filters.school=schoolId;
    const routeIds=new Set(a('routes').filter(route=>!schoolId||routeSchoolIds(route).includes(schoolId)).map(route=>route.id));
    if(!routeIds.has(S.filters.route))S.filters.route='';
    if(!routeIds.has(find('stops',S.filters.stop)?.rotaId))S.filters.stop='';
    syncStudentFilters();updateStudentResults();return;
  }
  if(id==='filterRoute'){S.filters.route=target.value;S.filters.stop='';syncStudentFilters();updateStudentResults();return;}
  if(id==='filterStop'){S.filters.stop=target.value;updateStudentResults();return;}
  if(id==='callDirection'){S.sentido=target.value;stopCamera();paintSnapshot();return;}
  if(id==='callRoute'){S.route=target.value;S.callSchool='';S.callStop='';stopCamera();paintSnapshot();return;}
  if(id==='callSchool'){S.callSchool=target.value;paintSnapshot();return;}
  if(id==='callStop'){S.callStop=target.value;paintSnapshot();return;}
  if(id==='callDay'){S.day=target.value||todayLocal();stopCamera();load(true);return;}
  if(target.dataset.cascade&&S.modal){
    const form=$('modalForm');if(!form)return;
    const draft={...S.modal.draft,...formData(form)};
    if(form.elements.namedItem('turnos'))draft.turnos=new FormData(form).getAll('turnos');
    if(target.name==='escolaId'){
      if(draft.escolaId&&!routeSchoolIds(find('routes',draft.rotaId)).includes(draft.escolaId)){draft.rotaId='';draft.pontoId='';}
    }
    if(target.name==='rotaId')draft.pontoId='';
    S.modal.draft=draft;render();$(id)?.focus({preventScroll:true});
  }
}
let studentSearchTimer;
function queueStudentSearch(e) {
  const input = e.target;
  if (input.id !== 'searchStudents' || e.isComposing) return;
  S.filters.search = input.value;
  clearTimeout(studentSearchTimer);
  studentSearchTimer = setTimeout(updateStudentResults,120);
}
document.addEventListener('click',e=>{handleClick(e).catch(warn);});
document.addEventListener('submit', async e => {
  const request = handleSubmit(e);
  const button = e.submitter || e.target.querySelector('button[type="submit"]');
  const showPending = S.busy && !closingDialog && button?.isConnected && !button.disabled;
  if (showPending) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  try {
    await request;
  } catch (error) {
    warn(error);
  } finally {
    if (showPending && button.isConnected) {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  }
});
document.addEventListener('change',handleChange);
document.addEventListener('input',queueStudentSearch);
document.addEventListener('compositionend',queueStudentSearch);

const visualViewport = window.visualViewport;
function syncDialogViewport() {
  const style = document.documentElement.style;
  // Pinch-zoom uses the normal layout viewport.
  if (visualViewport.scale !== 1) {
    style.removeProperty('--dialog-viewport-height');
    style.removeProperty('--dialog-viewport-top');
    return;
  }
  style.setProperty('--dialog-viewport-height', `${visualViewport.height}px`);
  style.setProperty('--dialog-viewport-top', `${visualViewport.offsetTop}px`);
}
if (visualViewport) {
  visualViewport.addEventListener('resize', syncDialogViewport);
  visualViewport.addEventListener('scroll', syncDialogViewport);
  syncDialogViewport();
}
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||closingDialog)return;
  if(S.modal&&!S.modal.mandatory)closeModal().catch(warn);
  else if(!S.modal&&S.menu){
    S.menu=false;
    render();
    $('portalMenu')?.focus({preventScroll:true});
  }
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)pauseLiveCamera();
  else refresh();
});
window.addEventListener('pagehide',()=>{
  pauseLiveCamera();
  stopCamera();
});
if(S.token)load();else render();
})();

}

// ============================================================================
// 5. INICIALIZAÇÃO DA INTERFACE
// ============================================================================
// O script usa defer no HTML; os elementos já existem quando a inicialização começa.
void initializeRotas();
})();
