// Генератор config/seeds.json: одни и те же 12 концептов на языке каждого гео.
// concept — языконезависимый ключ ниши. Без него слой F не работает:
// «document scanner» в US и «dokumente scannen» в DE — одна ниша, но по строке не сходятся.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONCEPTS = [
  'document-scanner', 'photo-translator', 'voice-recorder', 'habit-tracker',
  'unit-converter', 'qr-scanner', 'plant-identifier', 'white-noise',
  'focus-timer', 'screen-recorder', 'video-compressor', 'duplicate-photo-remover',
];

// Порядок строк в каждом языке совпадает с порядком CONCEPTS.
const T = {
  en: ['document scanner', 'photo translator', 'voice recorder', 'habit tracker',
       'unit converter', 'qr code scanner', 'plant identifier', 'white noise',
       'focus timer', 'screen recorder', 'video compressor', 'duplicate photo remover'],
  de: ['dokumente scannen', 'foto übersetzer', 'sprachaufnahme', 'gewohnheiten tracker',
       'einheiten umrechner', 'qr code scanner', 'pflanzen bestimmen', 'weißes rauschen',
       'fokus timer', 'bildschirm aufnehmen', 'video komprimieren', 'doppelte fotos löschen'],
  fr: ['scanner de documents', 'traducteur photo', 'enregistreur vocal', 'suivi des habitudes',
       "convertisseur d'unités", 'scanner qr code', 'identifier les plantes', 'bruit blanc',
       'minuteur de concentration', "enregistreur d'écran", 'compresser video', 'supprimer photos en double'],
  es: ['escaner de documentos', 'traductor de fotos', 'grabadora de voz', 'seguimiento de habitos',
       'convertidor de unidades', 'escaner qr', 'identificar plantas', 'ruido blanco',
       'temporizador de enfoque', 'grabar pantalla', 'comprimir video', 'eliminar fotos duplicadas'],
  pt: ['scanner de documentos', 'tradutor de fotos', 'gravador de voz', 'rastreador de habitos',
       'conversor de unidades', 'leitor de qr code', 'identificar plantas', 'ruido branco',
       'temporizador de foco', 'gravador de tela', 'comprimir video', 'remover fotos duplicadas'],
  it: ['scanner documenti', 'traduttore foto', 'registratore vocale', 'monitoraggio abitudini',
       'convertitore di unita', 'scanner qr code', 'identificare piante', 'rumore bianco',
       'timer concentrazione', 'registratore schermo', 'comprimere video', 'rimuovere foto duplicate'],
  nl: ['documenten scannen', 'foto vertaler', 'spraakrecorder', 'gewoonte tracker',
       'eenheden omrekenen', 'qr code scanner', 'planten herkennen', 'witte ruis',
       'focus timer', 'scherm opnemen', 'video comprimeren', 'dubbele fotos verwijderen'],
  sv: ['skanna dokument', 'foto översättare', 'röstinspelare', 'vanor tracker',
       'enhetsomvandlare', 'qr kod skanner', 'identifiera växter', 'vitt brus',
       'fokus timer', 'skärminspelare', 'komprimera video', 'ta bort dubbletter foton'],
  no: ['skanne dokumenter', 'foto oversetter', 'lydopptaker', 'vane tracker',
       'enhetsomregner', 'qr kode skanner', 'identifisere planter', 'hvit støy',
       'fokus timer', 'skjermopptaker', 'komprimere video', 'slette duplikat bilder'],
  da: ['scan dokumenter', 'foto oversætter', 'diktafon', 'vane tracker',
       'enhedsomregner', 'qr kode scanner', 'identificer planter', 'hvid støj',
       'fokus timer', 'skærmoptager', 'komprimer video', 'slet dublet billeder'],
  fi: ['asiakirjojen skannaus', 'kuvan kääntäjä', 'äänitallennin', 'tapojen seuranta',
       'yksikkömuunnin', 'qr koodin lukija', 'kasvien tunnistus', 'valkoinen kohina',
       'keskittymisajastin', 'näytön tallennus', 'videon pakkaus', 'poista kaksoiskuvat'],
  pl: ['skaner dokumentow', 'tlumacz zdjec', 'dyktafon', 'nawyki tracker',
       'przelicznik jednostek', 'skaner kodow qr', 'rozpoznawanie roslin', 'bialy szum',
       'minutnik skupienia', 'nagrywanie ekranu', 'kompresja wideo', 'usuwanie duplikatow zdjec'],
  tr: ['belge tarayici', 'fotograf ceviri', 'ses kaydedici', 'aliskanlik takip',
       'birim cevirici', 'qr kod okuyucu', 'bitki tanima', 'beyaz gurultu',
       'odaklanma zamanlayici', 'ekran kaydedici', 'video sikistirma', 'yinelenen fotograf silme'],
  ja: ['書類 スキャン', '写真 翻訳', 'ボイスレコーダー', '習慣 記録',
       '単位 変換', 'qrコード リーダー', '植物 判定', 'ホワイトノイズ',
       '集中 タイマー', '画面 録画', '動画 圧縮', '重複 写真 削除'],
  ko: ['문서 스캔', '사진 번역', '음성 녹음기', '습관 기록',
       '단위 변환기', 'qr 코드 스캐너', '식물 식별', '백색소음',
       '집중 타이머', '화면 녹화', '동영상 압축', '중복 사진 삭제'],
  zh: ['文件掃描', '照片翻譯', '錄音機', '習慣追蹤',
       '單位換算', 'qr code 掃描', '植物辨識', '白噪音',
       '專注計時器', '螢幕錄影', '影片壓縮', '重複照片清理'],
  ar: ['ماسح المستندات', 'ترجمة الصور', 'مسجل صوت', 'تتبع العادات',
       'محول الوحدات', 'قارئ باركود', 'التعرف على النباتات', 'ضوضاء بيضاء',
       'مؤقت التركيز', 'تسجيل الشاشة', 'ضغط الفيديو', 'حذف الصور المكررة'],
  he: ['סורק מסמכים', 'מתרגם תמונות', 'מקליט קול', 'מעקב הרגלים',
       'ממיר יחידות', 'סורק קוד qr', 'זיהוי צמחים', 'רעש לבן',
       'טיימר ריכוז', 'מקליט מסך', 'דחיסת וידאו', 'מחיקת תמונות כפולות'],
};

// Язык семян = первый язык отзывов гео (он же основной язык выдачи).
const GEO_LANG = {
  US: 'en', AU: 'en', GB: 'en', CA: 'en', DE: 'de', JP: 'ja', FR: 'fr', KR: 'ko',
  CH: 'de', NL: 'nl', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', NZ: 'en', AT: 'de',
  BE: 'nl', IE: 'en', SG: 'en', AE: 'ar', IL: 'he', IT: 'it', ES: 'es', SA: 'ar',
  PT: 'pt', BR: 'pt', TW: 'zh', PL: 'pl', MX: 'es', TR: 'tr',
};

// Семена US, добавленные вручную сверх общего набора: они уже собраны, терять их незачем.
const US_EXTRA = [
  ['water reminder', 'water-reminder'], ['noise meter', 'noise-meter'],
  ['wifi analyzer', 'wifi-analyzer'], ['handwriting to text', 'handwriting-to-text'],
  ['measure distance camera', 'distance-measure'], ['bird sound identifier', 'bird-sound-id'],
];

const keywords = {}, categories = {};
for (const [geo, lang] of Object.entries(GEO_LANG)) {
  const list = T[lang];
  if (!list) throw new Error(`нет перевода для языка ${lang} (гео ${geo})`);
  keywords[geo] = CONCEPTS.map((concept, i) => ({
    keyword: list[i], lang, concept, intent_type: 'generic', weight: 1,
  }));
  if (geo === 'US') {
    for (const [kw, concept] of US_EXTRA) {
      keywords[geo].push({ keyword: kw, lang, concept, intent_type: 'generic', weight: 1 });
    }
  }
  categories[geo] = ['TOOLS', 'PHOTOGRAPHY', 'PRODUCTIVITY'];
}

const out = {
  _note: 'Семена на языке гео (ТЗ 3.2). concept — языконезависимый ключ ниши: по нему слой F ' +
    'сопоставляет одну и ту же нишу между гео. Файл генерируется tools/gen-seeds.js.',
  concepts: CONCEPTS,
  keywords,
  apps: { US: [] },
  categories,
};
fs.writeFileSync(path.join(ROOT, 'config', 'seeds.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`семена: ${Object.keys(keywords).length} гео, ${CONCEPTS.length} концептов, ` +
  `${Object.values(keywords).reduce((a, l) => a + l.length, 0)} ключей`);
