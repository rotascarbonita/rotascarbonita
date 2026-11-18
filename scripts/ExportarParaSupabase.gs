/** Adicione como um NOVO arquivo ao projeto Apps Script atual, vinculado à planilha. */
function exportarParaSupabase() {
  var tables = {};
  var allowed = ['ANOS','ESCOLAS','TURMAS','ROTAS','PONTOS','ESTUDANTES','USUARIOS','ATRIBUICOES','CHAMADAS','DIAS_ROTA','MOTIVOS_AUSENCIA','AUDITORIA'];
  allowed.forEach(function (name) {
    tables[name] = readAllObjects_(name).map(function (source) {
      var row = {};
      SCHEMAS[name].forEach(function (key) {
        if (['senhaHash','salt','tokenHash','expiraEm'].indexOf(key) !== -1) return;
        var value = source[key];
        if (value instanceof Date) value = Utilities.formatDate(value, 'America/Sao_Paulo', name === 'CHAMADAS' && key === 'data' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ssXXX");
        row[key] = value === undefined ? '' : value;
      });
      return row;
    });
  });
  var file = DriveApp.createFile('Rotas_Carbonita_exportacao.json', JSON.stringify({ format: 1, exportedAt: new Date().toISOString(), tables: tables }), MimeType.PLAIN_TEXT);
  // O arquivo herda a privacidade padrão do Drive; este código não compartilha o arquivo.
  console.log('Baixe sua exportação: ' + file.getUrl());
  return file.getUrl();
}
