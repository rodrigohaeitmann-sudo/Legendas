/**
 * Google Apps Script — endpoint para receber palavras salvas dos apps de
 * idiomas (este app de vídeo e o leitor de EPUB compartilham o MESMO script e a
 * MESMA planilha).
 *
 * Como publicar:
 *   1. Abra https://script.google.com → Novo projeto.
 *   2. Cole este arquivo no editor.
 *   3. Em "Implantar" → "Nova implantação" → tipo "Aplicativo da Web".
 *      - Executar como: você mesmo.
 *      - Quem tem acesso: "Qualquer pessoa" (necessário para o app conseguir POST).
 *   4. Copie a URL gerada (termina em /exec) e cole no app, em
 *      Configurações → Palavras salvas e sincronização → Salvar URL.
 *
 * Para usar a MESMA planilha do app de EPUB, publique este script a partir do
 * mesmo projeto/planilha já usado lá (ou vincule-o à mesma planilha). A aba
 * "Palavras" e as colunas abaixo são idênticas nos dois apps.
 */

const SHEET_NAME = 'Palavras'
const HEADERS = [
  'Texto',
  'Tipo',
  'IPA',
  'Traduções',
  'Contexto',
  'Capítulo',
  'Fonte',
  'Salva em (app)',
  'Recebida em',
  'ID',
]

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents)
    const words = Array.isArray(body.words) ? body.words : []
    if (words.length === 0) return jsonOk({ saved: 0 })

    const sheet = getSheet_()
    const now = new Date()
    const rows = words.map((w) => [
      String(w.text || ''),
      String(w.kind || 'word'),
      String(w.ipa || ''),
      String(w.translations || ''),
      String(w.context || ''),
      String(w.chapter || ''),
      String(w.source || ''),
      String(w.savedAt || ''),
      now,
      String(w.id || ''),
    ])
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows)
    return jsonOk({ saved: rows.length })
  } catch (err) {
    return jsonErr(err && err.message ? err.message : String(err))
  }
}

function doGet() {
  return jsonOk({ alive: true })
}

function getSheet_() {
  let ss = SpreadsheetApp.getActiveSpreadsheet()
  if (!ss) ss = SpreadsheetApp.create('Palavras salvas (app de idiomas)')
  let sheet = ss.getSheetByName(SHEET_NAME)
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME)
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold')
    sheet.setFrozenRows(1)
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold')
    sheet.setFrozenRows(1)
  }
  return sheet
}

function jsonOk(payload) {
  return ContentService.createTextOutput(
    JSON.stringify(Object.assign({ ok: true }, payload || {})),
  ).setMimeType(ContentService.MimeType.JSON)
}

function jsonErr(message) {
  return ContentService.createTextOutput(
    JSON.stringify({ ok: false, error: message }),
  ).setMimeType(ContentService.MimeType.JSON)
}
