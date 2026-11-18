import { createClient } from 'npm:@supabase/supabase-js@2.95.3';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond({ error: 'Método não permitido.' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return respond({ error: 'Acesso não autorizado.' }, 401);
  const { data: identity, error: invalid } = await db.auth.getUser(token);
  if (invalid || !identity.user) return respond({ error: 'Sessão inválida. Entre novamente.' }, 401);
  const { data: actor } = await db.from('usuarios').select('id,perfil,ativo,exigeTroca').eq('auth_user_id', identity.user.id).single();
  if (!actor?.ativo || actor.exigeTroca || actor.perfil !== 'secretaria') return respond({ error: 'Apenas a Secretaria pode gerenciar acessos.' }, 403);
  let newAuthId: string | undefined;
  let resetPending = false;
  try {
    const body = await req.json();
    const item = body.item || {};
    item.login = String(item.login || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(item.login) || !String(item.nome || '').trim() || String(item.nome).length > 140 || !['secretaria', 'escola', 'monitor'].includes(item.perfil)) throw Error('Informe nome, login válido e perfil.');
    if (item.password && (typeof item.password !== 'string' || item.password.length < 12)) throw Error('A senha temporária precisa ter pelo menos 12 caracteres.');
    if (!item.id && !item.password) throw Error('Informe a senha temporária para a nova conta.');
    if (item.id === actor.id && (item.password || item.perfil !== 'secretaria' || item.ativo === 'NAO' || item.ativo === false)) throw Error('Para sua própria conta, use Alterar senha.');
    if (item.perfil === 'escola') {
      const { data: school } = await db.from('escolas').select('id').eq('id', item.escolaId).eq('ativo', true).maybeSingle();
      if (!school) throw Error('Selecione uma escola ativa.');
    }
    const query = db.from('usuarios').select('id,auth_user_id,login').eq(item.id ? 'id' : 'login', item.id || item.login);
    const { data: existing, error: queryError } = await query.maybeSingle();
    if (queryError) throw Error('Não foi possível conferir o acesso existente.');
    if (item.id && !existing) throw Error('Usuário não encontrado.');
    if (!item.id && existing) throw Error('Login já cadastrado. Atualize os acessos para conferir.');
    if (existing && existing.login !== item.login) throw Error('O login de uma conta existente não pode ser alterado.');
    let authId = existing?.auth_user_id;
    if (!authId) {
      if (!item.password) throw Error('Informe uma senha temporária para vincular este acesso.');
      const { data, error } = await db.auth.admin.createUser({ email: `${item.login}@acesso.rotas.invalid`, password: item.password, email_confirm: true });
      if (error) throw Error('Não foi possível criar a identidade. Confira se o login já existe no Authentication.');
      authId = data.user.id; newAuthId = authId;
    } else if (item.password) {
      const prepared = await db.rpc('rotas_prepare_password_reset', { actor_auth_id: identity.user.id, target_id: existing.id });
      if (prepared.error) throw Error(prepared.error.message);
      resetPending = true;
      const { error } = await db.auth.admin.updateUserById(authId, { password: item.password });
      if (error) throw Error('A redefinição não terminou. Repita a operação com uma senha válida.');
    }
    const { password, ...profile } = item;
    const { data, error } = await db.rpc('rotas_manage_user', { actor_auth_id: identity.user.id, item: profile, linked_auth_id: authId, password_reset: Boolean(password) });
    if (error) throw Error(error.message);
    return respond(data);
  } catch (error) {
    if (newAuthId) await db.auth.admin.deleteUser(newAuthId);
    const suffix = resetPending ? ' O acesso permanece bloqueado até a Secretaria concluir uma nova redefinição.' : '';
    return respond({ error: (error instanceof Error ? error.message : 'Falha ao gerenciar o acesso.') + suffix }, 400);
  }
});
