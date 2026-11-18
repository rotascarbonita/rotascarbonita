import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { prepareMigration } from '../scripts/prepare-migration.mjs';
import { loginEmail } from '../src/backend.js';

function fixture() { return { ANOS: [{ano:2026}], ESCOLAS:[{id:'e1',nome:"Escola D'Água"}], ROTAS:[{id:'r1',ano:2026,escolaId:'e1',nome:'Rota'}],
  USUARIOS:[{id:'u1',nome:'Admin',login:'ADMIN',perfil:'secretaria',senhaHash:'NAO_COPIAR_HASH',salt:'NAO_COPIAR_SALT'}],
  ESTUDANTES:[{id:'s1',ano:2026,escolaId:'e1',rotaId:'r1',pontoId:'',turmaId:'',nome:'Aluno Fictício',qrToken:'token-preservado',crachaCodigo:'RC-ABCD-2345',crachaAnteriores:'RC-ABCD-6789'}],
  SESSOES:[{tokenHash:'NAO_COPIAR_SESSAO'}] }; }
test('preparation preserves IDs, QR and retired badges; excludes old passwords and sessions', () => {
  const {sql,report}=prepareMigration(fixture());
  assert(sql.includes('token-preservado')); assert(sql.includes('RC-ABCD-6789')); assert(sql.includes("Escola D''Água"));
  assert(!sql.includes('NAO_COPIAR')); assert.equal(report.tables.estudantes,1);
});
test('preparation rejects invalid references, duplicate QR and duplicate normalized logins', () => {
  const missing=fixture(); missing.ESTUDANTES[0].rotaId='desconhecida'; assert.throws(()=>prepareMigration(missing),/Vínculo inválido/);
  const duplicate=fixture(); duplicate.ESTUDANTES.push({...duplicate.ESTUDANTES[0],id:'s2'}); assert.throws(()=>prepareMigration(duplicate),/QR duplicados/);
  const names=fixture(); names.USUARIOS.push({...names.USUARIOS[0],id:'u2',login:'admin'}); assert.throws(()=>prepareMigration(names),/logins duplicados/);
});
test('generated import executes in PostgreSQL and refuses to overwrite an occupied target', async () => {
  const db=new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);');
    await db.exec(await readFile('supabase/migrations/202611180001_schema.sql','utf8'));
    // Existing codes do not require a new badge; only import SQL and FK preservation are exercised here.
    const {sql}=prepareMigration(fixture());
    await db.exec(sql);
    assert.equal((await db.query('select "qrToken" from public.estudantes')).rows[0].qrToken,'token-preservado');
    await assert.rejects(db.exec(sql),/Destino não está vazio/);
  } finally { await db.close(); }
});
test('login uses the same normalized technical email as provisioned identities', () => {
  assert.equal(loginEmail('  Elenice  '),'elenice@acesso.rotas.invalid');
  assert.throws(()=>loginEmail('a@dominio.com'),/login individual/);
});
