import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,email text,encrypted_password text);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema public,auth to authenticated,anon,service_role;
  grant execute on function auth.uid() to authenticated,anon,service_role;`);
for (const f of (await readdir('supabase/migrations')).sort()) await db.exec(await readFile(`supabase/migrations/${f}`, 'utf8'));
await db.exec(`create or replace function private.today() returns date language sql stable as $$select date '2026-11-18'$$;
  insert into auth.users values
  ('00000000-0000-0000-0000-000000000001','admin@acesso.rotas.invalid','hash-admin'),
  ('00000000-0000-0000-0000-000000000002','escola@acesso.rotas.invalid','hash-escola'),
  ('00000000-0000-0000-0000-000000000003','monitor@acesso.rotas.invalid','hash-monitor'),
  ('00000000-0000-0000-0000-000000000004','inativo@acesso.rotas.invalid','hash-inativo'),
  ('00000000-0000-0000-0000-000000000005','primeiro@acesso.rotas.invalid','hash-temporario');
  insert into public.anos(ano) values('2026');
  insert into public.escolas(id,nome) values('ea','Escola A'),('eb','Escola B');
  insert into public.rotas(id,ano,"escolaId","escolaIds",nome) values('ra','2026','ea',array['ea'],'Leites'),('rb','2026','eb',array['eb'],'Simão'),('rc','2026','ea',array['ea','eb'],'Compartilhada');
  insert into public.pontos(id,"rotaId",nome) values('pa','ra','Ponto A'),('pb','rb','Ponto B'),('pc','rc','Ponto C');
  insert into public.usuarios(id,auth_user_id,nome,login,perfil,"escolaId","exigeTroca",ativo) values
  ('admin','00000000-0000-0000-0000-000000000001','Admin','admin','secretaria',null,false,true),
  ('escola','00000000-0000-0000-0000-000000000002','Escola A','escola','escola','ea',false,true),
  ('monitor','00000000-0000-0000-0000-000000000003','Monitor','monitor','monitor',null,false,true),
  ('inativo','00000000-0000-0000-0000-000000000004','Inativo','inativo','secretaria',null,false,false),
  ('primeiro','00000000-0000-0000-0000-000000000005','Primeiro','primeiro','monitor',null,true,true);
  insert into private.password_guards values('00000000-0000-0000-0000-000000000005','hash-temporario');
  insert into public.atribuicoes("usuarioId",ano,"rotaId") values('monitor','2026','ra'),('monitor','2026','rc');
  insert into public.estudantes(id,ano,"escolaId","rotaId","pontoId",nome,logradouro,"qrToken","crachaCodigo","criadoEm","rotaVinculadaEm") values
  ('sa','2026','ea','ra','pa','Aluno A','Rua A','token-a',private.new_badge('sa'),'2026-01-01','2026-01-01'),
  ('sb','2026','eb','rb','pb','Aluno B','Rua B','token-b',private.new_badge('sb'),'2026-01-01','2026-01-01'),
  ('sc','2026','eb','rc','pc','Aluno Compartilhado','Rua C','token-c',private.new_badge('sc'),'2026-01-01','2026-01-01'),
  ('sp','2026','ea',null,null,'Aluno Pendente','Rua D','token-p',private.new_badge('sp'),'2026-01-01',null);`);
const actors = { admin: 1, escola: 2, monitor: 3, inativo: 4, primeiro: 5 };
async function as(name, action, payload = {}) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [name ? `00000000-0000-0000-0000-${String(actors[name]).padStart(12, '0')}` : '']);
  await db.exec('set role authenticated');
  try { return (await db.query('select public.rotas_api($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result; }
  finally { await db.exec('reset role'); }
}
after(() => db.close());

test('RLS: anonymous and authenticated callers cannot read students or invoke admin helpers', async () => {
  await db.exec('set role anon');
  try { await assert.rejects(db.query(`select public.rotas_api('snapshot','{}')`), /permission denied/); await assert.rejects(db.query('select * from public.estudantes'), /permission denied/); }
  finally { await db.exec('reset role'); }
  await db.exec('set role authenticated');
  try { await assert.rejects(db.query('select * from public.estudantes'), /permission denied/); await assert.rejects(db.query(`select public.rotas_link_imported_user('sa',null)`), /permission denied/); }
  finally { await db.exec('reset role'); }
});
test('session must be active; temporary password cannot bypass change requirement', async () => {
  await assert.rejects(as(null, 'snapshot'), /Sessão inválida/);
  await assert.rejects(as('inativo', 'snapshot'), /Sessão inválida/);
  await assert.rejects(as('primeiro', 'snapshot'), /troca de senha/);
  assert.equal((await as('primeiro', 'me')).trocarSenha, 'SIM');
  await assert.rejects(as('primeiro', 'completePasswordChange'), /Altere sua senha/);
  await db.exec(`update auth.users set encrypted_password='hash-definitivo' where email='primeiro@acesso.rotas.invalid'`);
  assert.equal((await as('primeiro', 'completePasswordChange')).user.exigeTroca, false);
});
test('snapshot is scoped by school and assignment; monitor receives no QR secret or street', async () => {
  const school = await as('escola', 'snapshot');
  assert.deepEqual(school.schools.map(s => s.id), ['ea']);
  assert(school.students.every(s => s.escolaId === 'ea'));
  assert.equal(school.routes.find(r => r.id === 'rc').compartilhada, true);
  assert.deepEqual(school.routes.find(r => r.id === 'rc').escolaIds, ['ea']);
  assert(!school.users);
  const monitor = await as('monitor', 'snapshot');
  assert(!monitor.students.some(s => s.id === 'sb'));
  assert(monitor.students.some(s => s.id === 'sp'));
  assert(monitor.students.every(s => !s.qrToken && !s.logradouro && !s.crachaAnteriores));
});
test('save enforces ownership and does not accept profile escalation or arbitrary QR fields', async () => {
  await assert.rejects(as('escola', 'save', { type: 'student', item: { id: 'sb', escolaId: 'ea', nome: 'Tentativa' } }), /outra escola/);
  await assert.rejects(as('escola', 'save', { type: 'route', item: { id: 'rc', nome: 'Tentativa' } }), /compartilhadas/);
  await assert.rejects(as('monitor', 'save', { type: 'school', item: { nome: 'Tentativa' } }), /não permitida/);
  await as('monitor', 'save', { type: 'student', item: { id: 'sp', rotaId: 'ra', pontoId: 'pa', nome: 'Tentativa', escolaId: 'eb', qrToken: 'injetado' } });
  const row = (await db.query(`select nome,"escolaId","qrToken" from public.estudantes where id='sp'`)).rows[0];
  assert.deepEqual(row, { nome: 'Aluno Pendente', escolaId: 'ea', qrToken: 'token-p' });
  const saved = await as('admin', 'save', { type: 'student', year: '2026', item: { nome: 'Novo Aluno', escolaId: 'ea', rotaId: 'ra', pontoId: 'pa', turmaId: '', qrToken: 'injetado' } });
  const created = (await db.query('select * from public.estudantes where id=$1', [saved.id])).rows[0];
  assert.notEqual(created.qrToken, 'injetado'); assert.match(created.crachaCodigo, /^RC-/);
});
test('attendance protects route ownership and unique day/direction; QR confirms manual absence once', async () => {
  const base = { day: '2026-11-18', routeId: 'ra', sentido: 'IDA' };
  await assert.rejects(as('monitor', 'attendance', { ...base, routeId: 'rb', qr: 'TC:token-b' }), /não autorizado/);
  await assert.rejects(as('escola', 'attendance', { ...base, qr: 'TC:token-a' }), /Apenas/);
  await assert.rejects(as('monitor', 'attendance', { ...base, qr: 'TC:token-b' }), /não pertence/);
  await as('monitor', 'attendance', { ...base, studentId: 'sa', status: 'AUSENTE' });
  await assert.rejects(as('monitor', 'attendance', { ...base, studentId: 'sa' }), /Já existe/);
  const first = await as('monitor', 'attendance', { ...base, qr: 'TC:token-a' });
  const again = await as('monitor', 'attendance', { ...base, qr: 'TC:token-a' });
  assert.equal(first.status, 'PRESENTE'); assert.equal(again.duplicate, true); assert.equal(first.id, again.id);
  assert.equal((await db.query(`select count(*)::int n from public.chamadas where "estudanteId"='sa' and sentido='IDA'`)).rows[0].n, 1);
  await assert.rejects(db.query(`insert into public.chamadas select * from public.chamadas where id=$1`, [first.id]), /duplicate key/);
  await assert.rejects(as('monitor', 'attendance', { ...base, day: '2026-11-19', qr: 'TC:token-a' }), /data válida/);
});
test('badge replacement invalidates old QR and permanently reserves retired printed code', async () => {
  const old = (await db.query(`select "crachaCodigo" from public.estudantes where id='sa'`)).rows[0].crachaCodigo;
  const newBadge = await as('escola', 'replaceBadge', { studentId: 'sa', currentCode: old });
  assert.notEqual(newBadge.crachaCodigo, old);
  await assert.rejects(as('monitor', 'attendance', { day: '2026-11-18', routeId: 'ra', sentido: 'VOLTA', qr: 'TC:token-a' }), /não encontrado/);
  await assert.rejects(as('monitor', 'attendance', { day: '2026-11-18', routeId: 'ra', sentido: 'VOLTA', qr: old, typed: true }), /não encontrado/);
  assert.equal((await db.query('select count(*)::int n from private.badge_registry where code=$1', [old])).rows[0].n, 1);
});
test('import preview does not write; confirmation imports once and subsequent preview is idempotent', async () => {
  const payload = { year: '2026', escolaId: 'ea', rows: [{ nome: 'Importado 1', logradouro: 'Rua Um', bairro: 'Bairro Novo' }, { nome: 'Sem endereço', logradouro: 'Não informado', bairro: 'Bairro Novo' }] };
  const preview = await as('admin', 'importStudents', payload);
  assert.equal(preview.counts.created, 1); assert.equal(preview.counts.review, 1); assert.equal(preview.saved, false);
  assert.equal((await db.query(`select count(*)::int n from public.estudantes where nome='Importado 1'`)).rows[0].n, 0);
  const done = await as('admin', 'importStudents', { ...payload, confirmation: preview.confirmation });
  assert.equal(done.saved, true);
  const repeated = await as('admin', 'importStudents', payload);
  assert.equal(repeated.counts.existing, 1); assert.equal(repeated.counts.created, 0);
  await assert.rejects(as('escola', 'importStudents', { ...payload, escolaId: 'eb' }), /autorizada/);
});
test('three closed service days create absence alert; reopened day and presence break the streak', async () => {
  for (const day of ['2026-11-12', '2026-11-13', '2026-11-16']) await as('monitor', 'setRouteDay', { routeId: 'ra', day, closed: true });
  let snap = await as('monitor', 'snapshot');
  const alert = snap.absenceAlerts.find(a => a.estudanteId === 'sa');
  assert(alert); assert.equal(alert.dias, 3);
  await as('monitor', 'saveAbsence', { routeId: 'ra', studentId: 'sa', start: alert.inicio, reason: 'Motivo de teste', revision: '' });
  await assert.rejects(as('monitor', 'saveAbsence', { routeId: 'ra', studentId: 'sa', start: alert.inicio, reason: 'Outra edição', revision: '' }), /outro acesso/);
  await as('monitor', 'setRouteDay', { routeId: 'ra', day: '2026-11-13', closed: false });
  snap = await as('monitor', 'snapshot'); assert(!snap.absenceAlerts.some(a => a.estudanteId === 'sa'));
});
test('merge preserves badge, student identifiers and historical calls while resolving the canonical route', async () => {
  const before = (await db.query(`select "qrToken","crachaCodigo" from public.estudantes where id='sb'`)).rows[0];
  await as('admin', 'mergeRoutes', { primaryId: 'ra', secondaryId: 'rb' });
  const snap = await as('admin', 'snapshot');
  assert.equal(snap.students.find(s => s.id === 'sb').rotaId, 'ra');
  assert(snap.routes.find(r => r.id === 'ra').escolaIds.includes('eb'));
  assert.deepEqual((await db.query(`select "qrToken","crachaCodigo" from public.estudantes where id='sb'`)).rows[0], before);
  assert.equal((await db.query(`select "rotaId" from public.estudantes where id='sb'`)).rows[0].rotaId, 'rb');
});
test('assignment limits, disable integrity and changed revision are enforced', async () => {
  await assert.rejects(as('admin', 'setAssignments', { userId: 'monitor', year: '2026', routeIds: ['ra', 'rc', 'missing'] }), /duas rotas/);
  await assert.rejects(as('admin', 'disable', { type: 'route', id: 'ra' }), /estudantes ativos/);
  await assert.rejects(as('admin', 'disable', { type: 'user', id: 'admin' }), /próprio/);
  const snap = await as('admin', 'snapshot');
  assert.equal((await as('admin', 'updates', { version: snap.version })).changed, false);
  await as('admin', 'createYear', { year: '2027' });
  assert.equal((await as('admin', 'updates', { version: snap.version })).changed, true);
});

test('administrative password reset remains blocked until finalized and then changed by the user', async () => {
  const admin='00000000-0000-0000-0000-000000000001';
  const target='00000000-0000-0000-0000-000000000005';
  await db.exec('set role service_role');
  try { await db.query('select public.rotas_prepare_password_reset($1,$2)',[admin,'primeiro']); }
  finally { await db.exec('reset role'); }
  await db.query('update auth.users set encrypted_password=$1 where id=$2',['hash-novo-temporario',target]);
  await assert.rejects(as('primeiro','completePasswordChange'),/Altere sua senha/);
  await db.exec('set role service_role');
  try { await db.query('select public.rotas_manage_user($1,$2::jsonb,$3,true)',[admin,JSON.stringify({id:'primeiro',nome:'Primeiro',login:'primeiro',perfil:'monitor'}),target]); }
  finally { await db.exec('reset role'); }
  await assert.rejects(as('primeiro','completePasswordChange'),/Altere sua senha/);
  await db.query('update auth.users set encrypted_password=$1 where id=$2',['hash-definitivo-depois-reset',target]);
  assert.equal((await as('primeiro','completePasswordChange')).user.exigeTroca,false);
});
test('monitor setup preserves point IDs, creates 21 ordered stops and is repeatable', async () => {
  await db.exec(`insert into public.rotas(id,ano,"escolaId","escolaIds",nome) values('rs','2026','eb',array['eb'],'Simão nova');
    insert into public.pontos(id,"rotaId",nome,ordem) values('existing-stop','ra','Depósito do Otacílio',99);`);
  for (const [login,nome] of [['elenice','Elenice'],['leticia','Leticia'],['carla','Carla']]) {
    const authId=(await db.query(`insert into auth.users(id,email,encrypted_password) values(gen_random_uuid(),$1,'hash') returning id`,[`${login}@acesso.rotas.invalid`])).rows[0].id;
    await db.exec('set role service_role');
    try { await db.query('select public.rotas_manage_user($1,$2::jsonb,$3,true)',['00000000-0000-0000-0000-000000000001',JSON.stringify({nome,login,perfil:'monitor'}),authId]); }
    finally { await db.exec('reset role'); }
  }
  const payload={year:'2026',routeIds:{leites:'ra',simao:'rs'}};
  const first=await as('admin','setupMonitors',payload);
  assert.equal(first.counts.stopsCreated,20); assert.equal(first.counts.stopsUpdated,1); assert.equal(first.counts.assignmentsCreated,3);
  assert.equal((await db.query(`select ordem from public.pontos where id='existing-stop'`)).rows[0].ordem,2);
  const again=await as('admin','setupMonitors',payload);
  assert.equal(again.counts.stopsCreated,0); assert.equal(again.counts.stopsUpdated,0); assert.equal(again.counts.assignmentsCreated,0);
});
