import { createClient } from '@supabase/supabase-js';

export function loginEmail(login) {
  const value = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(value)) throw Error('Informe seu login individual, com pelo menos 3 caracteres.');
  return `${value}@acesso.rotas.invalid`;
}

export async function createBackend(url, publicKey) {
  const client = createClient(url, publicKey, {
    auth: { storage: window.sessionStorage, storageKey: 'rotas_auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  let { data: { session } } = await client.auth.getSession();
  let channel;
  const emit = name => window.dispatchEvent(new Event(name));
  const errorMessage = error => {
    if (/Invalid login credentials/i.test(error?.message || '')) return 'Login ou senha incorretos.';
    if (/Failed to fetch|fetch failed|NetworkError/i.test(error?.message || '')) return 'Sem conexão com o sistema. Confira a internet e tente novamente.';
    if (/JWT expired|refresh token|not authenticated/i.test(error?.message || '')) return 'Sessão expirada. Entre novamente.';
    return error?.message || 'Não foi possível concluir. Tente novamente.';
  };
  async function rpc(action, payload = {}) {
    const { data, error } = await client.rpc('rotas_api', { action, payload }).abortSignal(AbortSignal.timeout(action === 'importStudents' ? 45000 : 20000));
    if (error) throw Error(errorMessage(error));
    return data;
  }
  async function watch() {
    if (channel) { await client.removeChannel(channel); channel = undefined; }
    if (!session) return;
    channel = client.channel('rotas-sync').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sync_state' }, () => emit('rotas:changed')).subscribe();
  }
  client.auth.onAuthStateChange((event, nextSession) => {
    session = nextSession;
    if (event === 'SIGNED_OUT') emit('rotas:signed-out');
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(() => watch().catch(() => {}), 0);
  });
  async function manageUser(item) {
    const { data, error } = await client.functions.invoke('manage-users', { body: { item } });
    if (error) {
      let detail;
      try { detail = await error.context?.json(); } catch {}
      throw Error(detail?.error || errorMessage(error));
    }
    if (data?.error) throw Error(data.error);
    return data;
  }
  async function api(action, data = {}) {
    if (action === 'login') {
      const { error } = await client.auth.signInWithPassword({ email: loginEmail(data.login), password: data.password });
      if (error) throw Error(errorMessage(error));
      try { const user = await rpc('me'); await watch(); return { user }; }
      catch (error) { await client.auth.signOut({ scope: 'local' }); throw error; }
    }
    if (action === 'logout') {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw Error(errorMessage(error));
      return { success: true };
    }
    if (action === 'changePassword') {
      if (!data.current || !data.next || data.next.length < 12) throw Error('Informe a senha atual e uma nova senha de pelo menos 12 caracteres.');
      if (data.current === data.next) throw Error('A nova senha deve ser diferente da senha atual.');
      const email = session?.user?.email;
      if (!email) throw Error('Sessão expirada. Entre novamente.');
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
          await manageUser({ nome: monitor.nome, login: monitor.login, perfil: 'monitor', password: data.passwords?.[monitor.key] });
          created++;
        }
      }
      const result = await rpc(action, { year: data.year, routeIds: data.routeIds });
      result.counts.usersCreated = created;
      return result;
    }
    return rpc(action, data);
  }
  await watch();
  return { api, hasSession: () => Boolean(session) };
}
