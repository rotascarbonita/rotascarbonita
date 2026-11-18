import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try { process.loadEnvFile('.env'); } catch {}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || /SEU-PROJETO|SUA_CHAVE/.test(url + key)) throw Error('Preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env local.');
const client = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const credentialsPath = '.private/acessos-temporarios.json';
await mkdir('.private',{recursive:true,mode:0o700});
let saved = [];
try { saved = JSON.parse(await readFile(credentialsPath,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const persist = () => writeFile(credentialsPath,JSON.stringify(saved,null,2),{mode:0o600});
const temporary = () => randomBytes(18).toString('base64url') + 'aA7!';
const bootstrap = process.argv.includes('--bootstrap');
if (bootstrap) {
  const {data: existing,error} = await client.from('usuarios').select('id').limit(1);
  if (error) throw error;
  if (existing.length) throw Error('Já existem perfis. Use sem --bootstrap para provisionar os usuários importados.');
  const {error: insertError} = await client.from('usuarios').insert({nome:'Administrador Secretaria',login:'admin',perfil:'secretaria',exigeTroca:true});
  if (insertError) throw insertError;
}
const {data: profiles,error} = await client.from('usuarios').select('id,nome,login,auth_user_id,ativo').is('auth_user_id',null).eq('ativo',true);
if (error) throw error;
let completed=0;
for (const profile of profiles) {
  // Checkpoint antes de criar a identidade: uma interrupção não perde a senha temporária.
  let record=saved.find(r => r.id === profile.id);
  if (!record) { record={id:profile.id,nome:profile.nome,login:profile.login,password:temporary(),status:'preparado'}; saved.push(record); await persist(); }
  const created=await client.auth.admin.createUser({email:`${profile.login}@acesso.rotas.invalid`,password:record.password,email_confirm:true});
  let authId=created.data.user?.id;
  if (created.error) {
    // Recupera somente a conta que este script registrou antes da interrupção.
    const signed=await createClient(url,process.env.VITE_SUPABASE_PUBLISHABLE_KEY || key,{auth:{persistSession:false}}).auth.signInWithPassword({email:`${profile.login}@acesso.rotas.invalid`,password:record.password});
    authId=signed.data.user?.id;
    if (!authId) throw Error(`Não foi possível vincular ${profile.login}. Confira Authentication; nenhuma senha existente foi redefinida.`);
  }
  const linked=await client.rpc('rotas_link_imported_user',{profile_id:profile.id,linked_auth_id:authId});
  if (linked.error) throw linked.error;
  record.status='vinculado'; await persist(); completed++;
}
console.log(`${completed} acesso(s) vinculado(s). As senhas temporárias estão em ${credentialsPath}; cada usuário deve alterá-la no primeiro login.`);
