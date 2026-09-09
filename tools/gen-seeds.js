// Генератор config/seeds.json: каталог ниш на языке каждого гео.
// concept — языконезависимый ключ ниши. Без него слой F не работает:
// «document scanner» в US и «dokumente scannen» в DE — одна ниша, но по строке не сходятся.
//
// Каталог покрывает рынок простых утилит: то, что делает небольшая команда за месяцы,
// монетизируется подпиской или разовой покупкой и потому пригодно к копированию.
// Ниши, где выигрывает бренд или дистрибуция (мессенджеры, банки, соцсети, игры),
// сюда не входят: их door недостижим, сколько данных ни собирай.
//
// Порядок значений в строке ниши задаёт LANGS. Длина строки, минимальная длина ключа
// и уникальность ключа внутри языка проверяются при генерации, поэтому рассинхрон
// переводов или ключ, который отбросит harvest-keywords, не пройдут незамеченными.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LANGS = ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'tr', 'ja', 'ko', 'zh', 'ar', 'he'];

// [concept, en, de, fr, es, pt, it, nl, sv, no, da, fi, pl, tr, ja, ko, zh, ar, he]
const NICHES = [
  // --- Документы и сканирование ---
  ['document-scanner', 'document scanner', 'dokumente scannen', 'scanner de documents', 'escaner de documentos',
   'scanner de documentos', 'scanner documenti', 'documenten scannen', 'skanna dokument', 'skanne dokumenter',
   'scan dokumenter', 'asiakirjojen skannaus', 'skaner dokumentow', 'belge tarayici',
   '書類 スキャン', '문서 스캔', '文件掃描', 'ماسح المستندات', 'סורק מסמכים'],
  ['pdf-converter', 'pdf converter', 'pdf konverter', 'convertisseur pdf', 'convertidor pdf',
   'conversor pdf', 'convertitore pdf', 'pdf omzetten', 'pdf konverterare', 'pdf konverterer',
   'pdf omdanner', 'pdf muunnin', 'konwerter pdf', 'pdf donusturucu',
   'pdf 変換', 'pdf 변환기', 'pdf 轉檔', 'محول pdf', 'ממיר pdf'],
  ['text-scanner-ocr', 'image to text', 'bild in text umwandeln', 'image en texte', 'imagen a texto',
   'imagem para texto', 'da immagine a testo', 'afbeelding naar tekst', 'bild till text', 'bilde til tekst',
   'billede til tekst', 'kuva tekstiksi', 'zdjecie na tekst', 'resimden metne',
   '画像 文字起こし', '이미지 텍스트 변환', '圖片轉文字', 'تحويل الصورة الى نص', 'המרת תמונה לטקסט'],
  ['handwriting-to-text', 'handwriting to text', 'handschrift in text', 'ecriture manuscrite en texte', 'escritura a mano a texto',
   'escrita a mao para texto', 'scrittura a mano in testo', 'handschrift naar tekst', 'handskrift till text', 'handskrift til tekst',
   'handskrift til tekst dansk', 'kasiala tekstiksi', 'pismo odreczne na tekst', 'el yazisini metne cevirme',
   '手書き 文字 変換', '손글씨 텍스트 변환', '手寫轉文字', 'تحويل الكتابة اليدوية الى نص', 'המרת כתב יד לטקסט'],
  ['business-card-scanner', 'business card scanner', 'visitenkarten scanner', 'scanner de cartes de visite', 'escaner de tarjetas de visita',
   'leitor de cartao de visita', 'scanner biglietti da visita', 'visitekaartjes scannen', 'visitkortsskanner', 'visittkort skanner',
   'visitkort scanner', 'kayntikorttien skannaus', 'skaner wizytowek', 'kartvizit tarayici',
   '名刺 管理', '명함 스캔', '名片掃描', 'ماسح بطاقات العمل', 'סורק כרטיסי ביקור'],
  ['receipt-scanner', 'receipt scanner', 'kassenbon scanner', 'scanner de recus', 'escaner de recibos',
   'leitor de recibos', 'scanner scontrini', 'bonnetjes scannen', 'kvitto skanner', 'kvittering skanner',
   'kvittering scanner', 'kuittien skannaus', 'skaner paragonow', 'fis tarayici',
   'レシート 管理', '영수증 스캔', '收據掃描', 'ماسح الفواتير', 'סורק קבלות'],
  ['signature-maker', 'sign documents', 'dokumente unterschreiben', 'signer des documents', 'firmar documentos',
   'assinar documentos', 'firmare documenti', 'documenten ondertekenen', 'signera dokument', 'signere dokumenter',
   'underskriv dokumenter', 'allekirjoita asiakirjoja', 'podpisywanie dokumentow', 'belge imzalama',
   '電子 署名', '전자 서명', '電子簽名', 'توقيع المستندات', 'חתימה על מסמכים'],
  ['qr-scanner', 'qr code scanner', 'qr code scanner', 'scanner qr code', 'escaner qr',
   'leitor de qr code', 'scanner qr code', 'qr code scanner nederlands', 'qr kod skanner', 'qr kode skanner',
   'qr kode scanner', 'qr koodin lukija', 'skaner kodow qr', 'qr kod okuyucu',
   'qrコード リーダー', 'qr 코드 스캐너', 'qr code 掃描', 'قارئ باركود', 'סורק קוד qr'],

  // --- Фото ---
  ['photo-translator', 'photo translator', 'foto übersetzer', 'traducteur photo', 'traductor de fotos',
   'tradutor de fotos', 'traduttore foto', 'foto vertaler', 'foto översättare', 'foto oversetter',
   'foto oversætter', 'kuvan kääntäjä', 'tlumacz zdjec', 'fotograf ceviri',
   '写真 翻訳', '사진 번역', '照片翻譯', 'ترجمة الصور', 'מתרגם תמונות'],
  ['duplicate-photo-remover', 'duplicate photo remover', 'doppelte fotos löschen', 'supprimer photos en double', 'eliminar fotos duplicadas',
   'remover fotos duplicadas', 'rimuovere foto duplicate', 'dubbele fotos verwijderen', 'ta bort dubbletter foton', 'slette duplikat bilder',
   'slet dublet billeder', 'poista kaksoiskuvat', 'usuwanie duplikatow zdjec', 'yinelenen fotograf silme',
   '重複 写真 削除', '중복 사진 삭제', '重複照片清理', 'حذف الصور المكررة', 'מחיקת תמונות כפולות'],
  ['background-remover', 'background remover', 'hintergrund entfernen', 'supprimer arriere plan', 'quitar fondo de fotos',
   'remover fundo de fotos', 'rimuovere sfondo foto', 'achtergrond verwijderen', 'ta bort bakgrund', 'fjerne bakgrunn',
   'fjern baggrund', 'taustan poisto', 'usuwanie tla ze zdjec', 'arka plan silme',
   '背景 透過', '배경 제거', '去背景', 'ازالة الخلفية', 'הסרת רקע מתמונה'],
  ['photo-enhancer', 'photo enhancer', 'fotos verbessern', 'ameliorer photo', 'mejorar fotos',
   'melhorar fotos', 'migliorare foto', 'fotos verbeteren', 'förbättra foton', 'forbedre bilder',
   'forbedre billeder', 'kuvien parannus', 'poprawa jakosci zdjec', 'fotograf iyilestirme',
   '写真 高画質 化', '사진 화질 개선', '照片變清晰', 'تحسين جودة الصور', 'שיפור איכות תמונה'],
  ['old-photo-restorer', 'restore old photos', 'alte fotos restaurieren', 'restaurer vieilles photos', 'restaurar fotos antiguas',
   'restaurar fotos antigas', 'restaurare foto vecchie', 'oude fotos herstellen', 'restaurera gamla foton', 'restaurere gamle bilder',
   'restaurer gamle billeder', 'vanhojen kuvien korjaus', 'odnawianie starych zdjec', 'eski fotograf onarma',
   '古い 写真 修復', '오래된 사진 복원', '老照片修復', 'ترميم الصور القديمة', 'שחזור תמונות ישנות'],
  ['collage-maker', 'collage maker', 'collage erstellen', 'creer un collage', 'crear collage',
   'criar colagem', 'creare collage', 'collage maken', 'göra collage', 'lage collage',
   'lav collage', 'kollaasin teko', 'tworzenie kolazu', 'kolaj yapma',
   'コラージュ 作成', '콜라주 만들기', '拼圖製作', 'صانع الكولاج', 'יצירת קולאז'],
  ['watermark-remover', 'remove watermark', 'wasserzeichen entfernen', 'supprimer filigrane', 'quitar marca de agua',
   'remover marca dagua', 'rimuovere filigrana', 'watermerk verwijderen', 'ta bort vattenstämpel', 'fjerne vannmerke',
   'fjern vandmærke', 'vesileiman poisto', 'usuwanie znaku wodnego', 'filigran kaldirma',
   'ウォーターマーク 削除', '워터마크 제거', '去浮水印', 'ازالة العلامة المائية', 'הסרת סימן מים'],
  ['photo-compressor', 'compress photo', 'fotos komprimieren', 'compresser photo', 'comprimir fotos',
   'comprimir imagens', 'comprimere foto', 'fotos comprimeren', 'komprimera bilder', 'komprimere bilder',
   'komprimer billeder', 'kuvien pakkaus', 'kompresja zdjec', 'fotograf sikistirma',
   '画像 圧縮', '사진 용량 줄이기', '照片壓縮', 'ضغط الصور', 'דחיסת תמונות'],
  ['passport-photo-maker', 'passport photo', 'passbild erstellen', "photo d'identite", 'foto de carnet',
   'foto para passaporte', 'foto tessera', 'pasfoto maken', 'passfoto', 'passbilde',
   'pasfoto app', 'passikuva', 'zdjecie do dowodu', 'biyometrik fotograf',
   '証明 写真', '증명사진', '證件照', 'صورة شخصية للجواز', 'תמונת פספורט'],
  ['blur-photo', 'blur photo', 'foto unscharf machen', 'flouter une photo', 'difuminar fotos',
   'desfocar fotos', 'sfocare foto', 'foto vervagen', 'göra bild suddig', 'gjøre bilde uskarpt',
   'slør billede', 'kuvan sumennus', 'rozmycie zdjecia', 'fotograf bulaniklastirma',
   '写真 ぼかし', '사진 모자이크', '照片馬賽克', 'تمويه الصور', 'טשטוש תמונה'],

  // --- Видео и звук ---
  ['video-compressor', 'video compressor', 'video komprimieren', 'compresser video', 'comprimir video',
   'comprimir video celular', 'comprimere video', 'video comprimeren', 'komprimera video', 'komprimere video',
   'komprimer video', 'videon pakkaus', 'kompresja wideo', 'video sikistirma',
   '動画 圧縮', '동영상 압축', '影片壓縮', 'ضغط الفيديو', 'דחיסת וידאו'],
  ['screen-recorder', 'screen recorder', 'bildschirm aufnehmen', "enregistreur d'écran", 'grabar pantalla',
   'gravador de tela', 'registratore schermo', 'scherm opnemen', 'skärminspelare', 'skjermopptaker',
   'skærmoptager', 'näytön tallennus', 'nagrywanie ekranu', 'ekran kaydedici',
   '画面 録画', '화면 녹화', '螢幕錄影', 'تسجيل الشاشة', 'מקליט מסך'],
  ['video-to-mp3', 'video to mp3', 'video in mp3 umwandeln', 'video en mp3', 'video a mp3',
   'video para mp3', 'da video a mp3', 'video naar mp3', 'video till mp3', 'video til mp3',
   'video til mp3 lyd', 'video mp3 muunnin', 'wideo na mp3', 'videodan mp3',
   '動画 mp3 変換', '동영상 mp3 변환', '影片轉mp3', 'تحويل الفيديو الى mp3', 'המרת וידאו למפ3'],
  ['voice-recorder', 'voice recorder', 'sprachaufnahme', 'enregistreur vocal', 'grabadora de voz',
   'gravador de voz', 'registratore vocale', 'spraakrecorder', 'röstinspelare', 'lydopptaker',
   'diktafon', 'äänitallennin', 'dyktafon', 'ses kaydedici',
   'ボイスレコーダー', '음성 녹음기', '錄音機', 'مسجل صوت', 'מקליט קול'],
  ['voice-changer', 'voice changer', 'stimme verändern', 'modificateur de voix', 'cambiador de voz',
   'mudar voz', 'cambia voce', 'stem veranderen', 'röstförvrängare', 'stemmeforvrenger',
   'stemmeskifter', 'äänenmuuntaja', 'zmieniacz glosu', 'ses degistirici',
   'ボイスチェンジャー', '목소리 변조', '變聲器', 'مغير الصوت', 'משנה קול'],
  ['ringtone-maker', 'ringtone maker', 'klingelton erstellen', 'creer une sonnerie', 'crear tonos de llamada',
   'criar toques', 'creare suonerie', 'beltoon maken', 'skapa ringsignal', 'lage ringetone',
   'lav ringetone', 'soittoäänen teko', 'tworzenie dzwonkow', 'zil sesi yapma',
   '着信音 作成', '벨소리 만들기', '鈴聲製作', 'صانع النغمات', 'יצירת רינגטון'],
  ['mp3-cutter', 'mp3 cutter', 'mp3 schneiden', 'couper mp3', 'cortar mp3',
   'cortar audio mp3', 'tagliare mp3', 'mp3 knippen', 'klippa mp3', 'klippe mp3',
   'klip mp3', 'mp3 leikkuri', 'przycinanie mp3', 'mp3 kesme',
   'mp3 カット', 'mp3 자르기', 'mp3剪輯', 'قص mp3', 'חיתוך mp3'],
  ['speech-to-text', 'speech to text', 'sprache in text', 'parole en texte', 'voz a texto',
   'voz para texto', 'da voce a testo', 'spraak naar tekst', 'tal till text', 'tale til tekst',
   'tale til tekst dansk', 'puhe tekstiksi', 'mowa na tekst', 'sesi yaziya cevirme',
   '音声 文字起こし', '음성 텍스트 변환', '語音轉文字', 'تحويل الصوت الى نص', 'המרת דיבור לטקסט'],
  ['guitar-tuner', 'guitar tuner', 'gitarren stimmgerät', 'accordeur de guitare', 'afinador de guitarra',
   'afinador de violao', 'accordatore chitarra', 'gitaar stemapparaat', 'gitarrstämmare', 'gitarstemmer',
   'guitar stemmer', 'kitaran viritin', 'stroik do gitary', 'gitar akort',
   'ギター チューナー', '기타 튜너', '吉他調音器', 'موالف الجيتار', 'מכוון גיטרה'],
  ['metronome', 'metronome', 'metronom', 'metronome musique', 'metronomo',
   'metronomo digital', 'metronomo musica', 'metronoom', 'metronom takt', 'metronom app',
   'metronom musik', 'metronomi', 'metronom do cwiczen', 'metronom ritim',
   'メトロノーム', '메트로놈', '節拍器', 'مترونوم', 'מטרונום'],

  // --- Звук вокруг ---
  ['white-noise', 'white noise', 'weißes rauschen', 'bruit blanc', 'ruido blanco',
   'ruido branco', 'rumore bianco', 'witte ruis', 'vitt brus', 'hvit støy',
   'hvid støj', 'valkoinen kohina', 'bialy szum', 'beyaz gurultu',
   'ホワイトノイズ', '백색소음', '白噪音', 'ضوضاء بيضاء', 'רעש לבן'],
  ['noise-meter', 'noise meter', 'lärm messen', 'sonometre', 'medidor de ruido',
   'medidor de ruido db', 'fonometro', 'geluidsmeter', 'ljudmätare', 'støymåler',
   'støjmåler', 'melumittari', 'miernik halasu', 'gurultu olcer',
   '騒音 測定', '소음 측정', '噪音檢測', 'مقياس الضوضاء', 'מד רעש'],
  ['sound-amplifier', 'sound amplifier', 'hörverstärker', 'amplificateur de son', 'amplificador de sonido',
   'amplificador de som', 'amplificatore audio', 'geluidsversterker', 'ljudförstärkare', 'lydforsterker',
   'lydforstærker', 'äänenvahvistin', 'wzmacniacz dzwieku', 'ses yukseltici',
   '集音器', '소리 증폭기', '聲音放大器', 'مكبر الصوت', 'מגבר קול'],

  // --- Измерения и датчики ---
  ['unit-converter', 'unit converter', 'einheiten umrechner', "convertisseur d'unités", 'convertidor de unidades',
   'conversor de unidades', 'convertitore di unita', 'eenheden omrekenen', 'enhetsomvandlare', 'enhetsomregner',
   'enhedsomregner', 'yksikkömuunnin', 'przelicznik jednostek', 'birim cevirici',
   '単位 変換', '단위 변환기', '單位換算', 'محول الوحدات', 'ממיר יחידות'],
  ['distance-measure', 'measure distance camera', 'entfernung messen kamera', 'mesurer distance camera', 'medir distancia con camara',
   'medir distancia camera', 'misurare distanza fotocamera', 'afstand meten camera', 'mäta avstånd kamera', 'måle avstand kamera',
   'mål afstand kamera', 'etäisyyden mittaus kameralla', 'pomiar odleglosci kamera', 'kamera ile mesafe olcme',
   'カメラ 距離 測定', '카메라 거리 측정', '相機測距', 'قياس المسافة بالكاميرا', 'מדידת מרחק במצלמה'],
  ['ruler', 'ruler app', 'lineal app', 'regle virtuelle', 'regla digital',
   'regua digital', 'righello digitale', 'liniaal app', 'linjal app', 'linjal app norsk',
   'lineal app dansk', 'viivain sovellus', 'linijka aplikacja', 'cetvel uygulamasi',
   'スマホ 定規', '스마트폰 자', '手機尺子', 'مسطرة قياس', 'סרגל דיגיטלי'],
  ['bubble-level', 'bubble level', 'wasserwaage', 'niveau a bulle', 'nivel de burbuja',
   'nivel de bolha', 'livella a bolla', 'waterpas', 'vattenpass', 'vater app',
   'vaterpas', 'vesivaaka', 'poziomica', 'su terazisi',
   '水平器 アプリ', '수평계', '水平儀', 'ميزان الماء', 'פלס בועה'],
  ['compass', 'compass app', 'kompass app', 'boussole', 'brujula',
   'bussola digital', 'bussola digitale', 'kompas app', 'kompass app svenska', 'kompass app norsk',
   'kompas app dansk', 'kompassi sovellus', 'kompas aplikacja', 'pusula',
   'コンパス 方位', '나침반', '指南針', 'بوصلة', 'מצפן'],
  ['magnifier', 'magnifier', 'lupe app', 'loupe', 'lupa digital',
   'lupa digital celular', "lente d'ingrandimento", 'vergrootglas', 'förstoringsglas', 'forstørrelsesglass',
   'forstørrelsesglas', 'suurennuslasi', 'lupa aplikacja', 'buyutec',
   '虫眼鏡 アプリ', '돋보기', '放大鏡', 'عدسة مكبرة', 'זכוכית מגדלת'],
  ['speedometer', 'gps speedometer', 'tacho app', 'compteur de vitesse gps', 'velocimetro gps',
   'velocimetro gps celular', 'tachimetro gps', 'snelheidsmeter gps', 'hastighetsmätare gps', 'hastighetsmåler gps',
   'speedometer gps', 'nopeusmittari gps', 'predkosciomierz gps', 'gps hiz gostergesi',
   'gps スピードメーター', 'gps 속도계', 'gps 測速器', 'عداد السرعة gps', 'מד מהירות gps'],
  ['altimeter', 'altimeter', 'höhenmesser', 'altimetre', 'altimetro',
   'altimetro celular', 'altimetro gps', 'hoogtemeter', 'höjdmätare', 'høydemåler',
   'højdemåler', 'korkeusmittari', 'wysokosciomierz', 'yukseklik olcer',
   '高度計 アプリ', '고도계', '海拔高度計', 'مقياس الارتفاع', 'מד גובה'],
  ['protractor', 'angle meter', 'winkelmesser', "rapporteur d'angle", 'medidor de angulos',
   'medidor de angulo', 'goniometro', 'hoekmeter', 'vinkelmätare', 'vinkelmåler',
   'vinkelmaaler dansk', 'kulmamittari', 'katomierz', 'aci olcer',
   '角度 測定', '각도 측정기', '角度測量', 'مقياس الزاوية', 'מד זווית'],

  // --- Здоровье и привычки ---
  ['habit-tracker', 'habit tracker', 'gewohnheiten tracker', 'suivi des habitudes', 'seguimiento de habitos',
   'rastreador de habitos', 'monitoraggio abitudini', 'gewoonte tracker', 'vanor tracker', 'vane tracker',
   'vane tracker dansk', 'tapojen seuranta', 'nawyki tracker', 'aliskanlik takip',
   '習慣 記録', '습관 기록', '習慣追蹤', 'تتبع العادات', 'מעקב הרגלים'],
  ['water-reminder', 'water reminder', 'trinkerinnerung', 'rappel de boire de l eau', 'recordatorio de beber agua',
   'lembrete de beber agua', 'promemoria bere acqua', 'water drinken herinnering', 'dricka vatten påminnelse', 'drikke vann påminnelse',
   'drik vand påmindelse', 'juomamuistutus', 'przypomnienie o piciu wody', 'su icme hatirlatici',
   '水分 補給 記録', '물 마시기 알림', '喝水提醒', 'تذكير شرب الماء', 'תזכורת שתיית מים'],
  ['focus-timer', 'focus timer', 'fokus timer', 'minuteur de concentration', 'temporizador de enfoque',
   'temporizador de foco', 'timer concentrazione', 'focus timer app', 'fokus timer svenska', 'fokus timer norsk',
   'fokus timer dansk', 'keskittymisajastin', 'minutnik skupienia', 'odaklanma zamanlayici',
   '集中 タイマー', '집중 타이머', '專注計時器', 'مؤقت التركيز', 'טיימר ריכוז'],
  ['sleep-tracker', 'sleep tracker', 'schlaf tracker', 'suivi du sommeil', 'monitor de sueno',
   'monitor de sono', 'monitoraggio del sonno', 'slaap tracker', 'sömn tracker', 'søvn tracker',
   'søvn tracker dansk', 'unen seuranta', 'monitor snu', 'uyku takip',
   '睡眠 記録', '수면 기록', '睡眠追蹤', 'تتبع النوم', 'מעקב שינה'],
  ['period-tracker', 'period tracker', 'periode kalender', 'suivi des regles', 'calendario menstrual',
   'calendario menstrual app', 'calendario mestruale', 'menstruatie kalender', 'menscykel kalender', 'menstruasjon kalender',
   'menstruation kalender', 'kuukautiskalenteri', 'kalendarz miesiaczkowy', 'regl takvimi',
   '生理 記録', '생리 달력', '生理期記錄', 'تتبع الدورة الشهرية', 'מעקב מחזור'],
  ['calorie-counter', 'calorie counter', 'kalorienzähler', 'compteur de calories', 'contador de calorias',
   'contador de calorias app', 'contacalorie', 'calorieënteller', 'kaloriräknare', 'kalorieteller',
   'kalorietæller', 'kalorilaskuri', 'licznik kalorii', 'kalori sayaci',
   'カロリー 計算', '칼로리 계산기', '卡路里計算', 'حاسبة السعرات', 'מונה קלוריות'],
  ['interval-timer', 'interval timer', 'intervall timer', "minuteur d'intervalle", 'temporizador de intervalos',
   'temporizador de intervalos treino', 'timer a intervalli', 'interval timer app', 'intervalltimer', 'intervall timer norsk',
   'interval timer dansk', 'intervalliajastin', 'minutnik interwalowy', 'interval zamanlayici',
   'インターバル タイマー', '인터벌 타이머', '間歇計時器', 'مؤقت التمارين', 'טיימר אינטרוולים'],
  ['step-counter', 'step counter', 'schrittzähler', 'podometre', 'podometro',
   'pedometro', 'contapassi', 'stappenteller', 'stegräknare', 'skritteller',
   'skridttæller', 'askelmittari', 'krokomierz', 'adim sayar',
   '歩数計 アプリ', '만보기', '計步器', 'عداد الخطوات', 'מונה צעדים'],
  ['breathing-exercise', 'breathing exercise', 'atemübungen', 'exercices de respiration', 'ejercicios de respiracion',
   'exercicios de respiracao', 'esercizi di respirazione', 'ademhalingsoefeningen', 'andningsövningar', 'pusteøvelser',
   'vejrtrækningsøvelser', 'hengitysharjoitukset', 'cwiczenia oddechowe', 'nefes egzersizi',
   '呼吸 法 練習', '호흡 운동', '呼吸練習', 'تمارين التنفس', 'תרגילי נשימה'],
  ['weight-tracker', 'weight tracker', 'gewicht tagebuch', 'suivi du poids', 'control de peso',
   'controle de peso', 'monitoraggio peso', 'gewicht bijhouden', 'viktkurva', 'vektlogg',
   'vægt log', 'painon seuranta', 'dziennik wagi', 'kilo takip',
   '体重 記録', '체중 기록', '體重記錄', 'تتبع الوزن', 'מעקב משקל'],
  ['blood-pressure-log', 'blood pressure log', 'blutdruck tagebuch', 'tension arterielle suivi', 'registro de presion arterial',
   'registro de pressao arterial', 'diario pressione sanguigna', 'bloeddruk dagboek', 'blodtryck dagbok', 'blodtrykk dagbok',
   'blodtryk dagbog', 'verenpaineen seuranta', 'dziennik cisnienia', 'tansiyon takip',
   '血圧 記録', '혈압 기록', '血壓記錄', 'تسجيل ضغط الدم', 'מעקב לחץ דם'],

  // --- Определение по фото и звуку ---
  ['plant-identifier', 'plant identifier', 'pflanzen bestimmen', 'identifier les plantes', 'identificar plantas',
   'identificar plantas app', 'identificare piante', 'planten herkennen', 'identifiera växter', 'identifisere planter',
   'identificer planter', 'kasvien tunnistus', 'rozpoznawanie roslin', 'bitki tanima',
   '植物 判定', '식물 식별', '植物辨識', 'التعرف على النباتات', 'זיהוי צמחים'],
  ['bird-sound-id', 'bird sound identifier', 'vogelstimmen erkennen', 'identifier chant oiseau', 'identificar canto de aves',
   'identificar canto de passaros', 'riconoscere canto uccelli', 'vogelgeluiden herkennen', 'identifiera fågelsång', 'gjenkjenne fuglesang',
   'genkend fuglesang', 'linnunlaulun tunnistus', 'rozpoznawanie ptakow po glosie', 'kus sesi tanima',
   '野鳥 鳴き声 判定', '새소리 식별', '鳥鳴辨識', 'التعرف على اصوات الطيور', 'זיהוי ציוץ ציפורים'],
  ['mushroom-identifier', 'mushroom identifier', 'pilze bestimmen', 'identifier les champignons', 'identificar setas',
   'identificar cogumelos', 'riconoscere funghi', 'paddenstoelen herkennen', 'identifiera svampar', 'identifisere sopp',
   'identificer svampe', 'sienten tunnistus', 'rozpoznawanie grzybow', 'mantar tanima',
   'きのこ 判定', '버섯 식별', '蘑菇辨識', 'التعرف على الفطر', 'זיהוי פטריות'],
  ['rock-identifier', 'rock identifier', 'steine bestimmen', 'identifier les pierres', 'identificar rocas',
   'identificar pedras', 'riconoscere rocce', 'stenen herkennen', 'identifiera stenar', 'identifisere steiner',
   'identificer sten', 'kivien tunnistus', 'rozpoznawanie kamieni', 'tas tanima',
   '石 鉱物 判定', '광물 식별', '石頭辨識', 'التعرف على الصخور', 'זיהוי אבנים'],
  ['dog-breed-identifier', 'dog breed identifier', 'hunderassen erkennen', 'identifier race de chien', 'identificar raza de perro',
   'identificar raca de cachorro', 'riconoscere razza cane', 'hondenras herkennen', 'identifiera hundras', 'gjenkjenne hunderase',
   'genkend hunderace', 'koirarodun tunnistus', 'rozpoznawanie ras psow', 'kopek irki tanima',
   '犬種 判定', '강아지 품종 식별', '狗品種辨識', 'التعرف على سلالة الكلب', 'זיהוי גזע כלב'],
  ['insect-identifier', 'insect identifier', 'insekten bestimmen', 'identifier les insectes', 'identificar insectos',
   'identificar insetos', 'riconoscere insetti', 'insecten herkennen', 'identifiera insekter', 'identifisere insekter',
   'identificer insekter', 'hyönteisten tunnistus', 'rozpoznawanie owadow', 'bocek tanima',
   '昆虫 判定', '곤충 식별', '昆蟲辨識', 'التعرف على الحشرات', 'זיהוי חרקים'],

  // --- Устройство и сеть ---
  ['wifi-analyzer', 'wifi analyzer', 'wlan analyse', 'analyseur wifi', 'analizador wifi',
   'analisador wifi', 'analizzatore wifi', 'wifi analyse', 'wifi analys', 'wifi analyse norsk',
   'wifi analyse dansk', 'wifi analysaattori', 'analizator wifi', 'wifi analiz',
   'wifi 分析', '와이파이 분석', 'wifi 分析', 'تحليل الواي فاي', 'מנתח רשתות wifi'],
  ['speed-test', 'internet speed test', 'internet geschwindigkeit test', 'test de debit internet', 'test de velocidad de internet',
   'teste de velocidade da internet', 'test velocita internet', 'internetsnelheid test', 'hastighetstest internet', 'hastighetstest internett',
   'hastighedstest internet', 'nopeustesti internet', 'test predkosci internetu', 'internet hiz testi',
   '通信 速度 測定', '인터넷 속도 측정', '網速測試', 'اختبار سرعة الانترنت', 'בדיקת מהירות אינטרנט'],
  ['battery-monitor', 'battery monitor', 'akku überwachung', 'moniteur de batterie', 'monitor de bateria',
   'monitor de bateria celular', 'monitor batteria', 'batterij monitor', 'batteriövervakning', 'batteriovervåking',
   'batteriovervågning', 'akun seuranta', 'monitor baterii', 'pil takip',
   'バッテリー 監視', '배터리 관리', '電池監控', 'مراقبة البطارية', 'ניטור סוללה'],
  ['device-info', 'device info', 'geräteinformationen', 'informations appareil', 'informacion del dispositivo',
   'informacoes do dispositivo', 'informazioni dispositivo', 'apparaat informatie', 'enhetsinformation', 'enhetsinformasjon',
   'enhedsoplysninger', 'laitetiedot', 'informacje o urzadzeniu', 'cihaz bilgisi',
   '端末 情報', '기기 정보', '手機資訊', 'معلومات الجهاز', 'מידע על המכשיר'],
  ['app-lock', 'app lock', 'apps sperren', "verrouillage d'applications", 'bloqueo de aplicaciones',
   'bloqueio de aplicativos', 'blocco app', 'apps vergrendelen', 'applås', 'applås norsk',
   'applås dansk', 'sovelluslukko', 'blokada aplikacji', 'uygulama kilidi',
   'アプリ ロック', '앱 잠금', '應用鎖', 'قفل التطبيقات', 'נעילת אפליקציות'],
  ['screen-mirroring', 'screen mirroring', 'bildschirm übertragen', 'partage d ecran tv', 'duplicar pantalla en tv',
   'espelhamento de tela', 'duplicare schermo tv', 'scherm delen tv', 'skärmdelning tv', 'skjermdeling tv',
   'skærmdeling tv', 'näytön jakaminen tv', 'udostepnianie ekranu tv', 'ekran yansitma',
   '画面 ミラーリング', '화면 미러링', '螢幕鏡射', 'مشاركة الشاشة تلفاز', 'שיקוף מסך לטלוויזיה'],
  ['phone-finder', 'find my phone whistle', 'handy finden pfeifen', 'retrouver mon telephone sifflet', 'encontrar mi telefono silbido',
   'encontrar meu celular assobio', 'trovare telefono fischio', 'telefoon vinden fluiten', 'hitta min telefon vissla', 'finne telefonen plystre',
   'find min telefon fløjt', 'löydä puhelin vihellys', 'znajdz telefon gwizdek', 'telefon bulma islik',
   'スマホ 探す 音', '휴대폰 찾기 휘파람', '手機尋找 口哨', 'البحث عن هاتفي بالصفير', 'איתור טלפון בשריקה'],
  ['notification-history', 'notification history', 'benachrichtigungsverlauf', 'historique des notifications', 'historial de notificaciones',
   'historico de notificacoes', 'cronologia notifiche', 'meldingen geschiedenis', 'aviseringshistorik', 'varselhistorikk',
   'notifikationshistorik', 'ilmoitushistoria', 'historia powiadomien', 'bildirim gecmisi',
   '通知 履歴', '알림 기록', '通知記錄', 'سجل الاشعارات', 'היסטוריית התראות'],

  // --- Быт и планирование ---
  ['expense-tracker', 'expense tracker', 'haushaltsbuch', 'suivi des depenses', 'control de gastos',
   'controle de gastos', 'gestione spese', 'uitgaven bijhouden', 'utgiftskoll', 'utgiftsoversikt',
   'udgiftsoversigt', 'menojen seuranta', 'kontrola wydatkow', 'harcama takip',
   '家計 簿', '가계부', '記帳本', 'تتبع المصروفات', 'מעקב הוצאות'],
  ['grocery-list', 'grocery list', 'einkaufsliste', 'liste de courses', 'lista de compras',
   'lista de compras supermercado', 'lista della spesa', 'boodschappenlijst', 'inköpslista', 'handleliste',
   'indkøbsliste', 'ostoslista', 'lista zakupow', 'alisveris listesi',
   '買い物 リスト', '장보기 목록', '購物清單', 'قائمة التسوق', 'רשימת קניות'],
  ['event-countdown', 'countdown timer', 'countdown zähler', 'compte a rebours', 'cuenta regresiva',
   'contagem regressiva', 'conto alla rovescia', 'aftellen naar datum', 'nedräkning', 'nedtelling',
   'nedtælling', 'lähtölaskenta', 'odliczanie do daty', 'geri sayim',
   'カウントダウン', '디데이 카운트', '倒數計時', 'العد التنازلي', 'ספירה לאחור'],
  ['shift-scheduler', 'work shift calendar', 'schichtplan kalender', 'calendrier de travail postes', 'calendario de turnos',
   'calendario de turnos trabalho', 'calendario turni', 'dienstrooster', 'skiftschema', 'skiftplan',
   'vagtplan', 'työvuorokalenteri', 'grafik zmian', 'vardiya takvimi',
   'シフト 管理', '근무 일정', '排班表', 'جدول المناوبات', 'לוח משמרות'],
  ['currency-converter', 'currency converter', 'währungsrechner', 'convertisseur de devises', 'conversor de divisas',
   'conversor de moedas', 'convertitore di valuta', 'valuta omrekenen', 'valutaomvandlare', 'valutakalkulator',
   'valutaomregner', 'valuuttamuunnin', 'przelicznik walut', 'doviz cevirici',
   '為替 換算', '환율 계산기', '匯率換算', 'محول العملات', 'ממיר מטבעות'],
  ['fuel-log', 'fuel consumption log', 'spritverbrauch tagebuch', 'carnet de consommation carburant', 'registro de consumo de combustible',
   'registro de consumo de combustivel', 'diario consumo carburante', 'brandstofverbruik bijhouden', 'bränsleförbrukning logg', 'drivstofforbruk logg',
   'brændstofforbrug log', 'polttoaineenkulutus seuranta', 'dziennik spalania paliwa', 'yakit tuketim takibi',
   '燃費 記録', '연비 기록', '油耗記錄', 'سجل استهلاك الوقود', 'מעקב צריכת דלק'],
  ['moon-phase', 'moon phase calendar', 'mondphasen kalender', 'calendrier lunaire', 'calendario lunar',
   'calendario lunar fases', 'calendario lunare', 'maankalender', 'månkalender', 'månekalender',
   'månekalender dansk', 'kuukalenteri', 'kalendarz ksiezycowy', 'ay takvimi',
   '月齢 カレンダー', '달력 음력', '月相日曆', 'تقويم القمر', 'לוח ירח'],
];

// Язык семян = первый язык отзывов гео (он же основной язык выдачи).
const GEO_LANG = {
  US: 'en', AU: 'en', GB: 'en', CA: 'en', DE: 'de', JP: 'ja', FR: 'fr', KR: 'ko',
  CH: 'de', NL: 'nl', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', NZ: 'en', AT: 'de',
  BE: 'nl', IE: 'en', SG: 'en', AE: 'ar', IL: 'he', IT: 'it', ES: 'es', SA: 'ar',
  PT: 'pt', BR: 'pt', TW: 'zh', PL: 'pl', MX: 'es', TR: 'tr',
};

// Категории, где живут простые утилиты. Список задаёт три вещи сразу: какие чарты
// снимаются (D5), докуда расходится граф похожих (D3) и что не отсеет скрининг (C).
const CATEGORIES = [
  'TOOLS', 'PHOTOGRAPHY', 'PRODUCTIVITY', 'VIDEO_PLAYERS', 'MUSIC_AND_AUDIO',
  'HEALTH_AND_FITNESS', 'MEDICAL', 'LIFESTYLE', 'EDUCATION', 'ART_AND_DESIGN',
  'PERSONALIZATION', 'WEATHER', 'MAPS_AND_NAVIGATION', 'BOOKS_AND_REFERENCE',
  'AUTO_AND_VEHICLES', 'HOUSE_AND_HOME',
];

// Проверки каталога. Любая из этих ошибок в бою обходится дороже: рассинхронённая
// строка молча подставит нише чужой перевод, а слишком короткий ключ отбросит
// harvest-keywords — ниша просто исчезнет из обхода, и это никак не проявится.
const seenConcepts = new Set();
for (const row of NICHES) {
  const [concept] = row;
  if (row.length !== LANGS.length + 1) {
    throw new Error(`ниша ${concept}: ${row.length - 1} переводов вместо ${LANGS.length}`);
  }
  if (seenConcepts.has(concept)) throw new Error(`концепт ${concept} объявлен дважды`);
  seenConcepts.add(concept);
  row.slice(1).forEach((kw, i) => {
    if (!kw || kw.length < 3) {
      throw new Error(`ниша ${concept}, язык ${LANGS[i]}: ключ «${kw}» короче 3 символов — harvest-keywords его отбросит`);
    }
    if (kw !== kw.trim() || /\s{2,}/.test(kw)) {
      throw new Error(`ниша ${concept}, язык ${LANGS[i]}: лишние пробелы в «${kw}»`);
    }
  });
}
LANGS.forEach((lang, i) => {
  const byKw = new Map();
  for (const row of NICHES) {
    const kw = row[i + 1].toLowerCase();
    if (byKw.has(kw)) {
      throw new Error(`язык ${lang}: ключ «${kw}» занят нишами ${byKw.get(kw)} и ${row[0]} — одна останется без выдачи`);
    }
    byKw.set(kw, row[0]);
  }
});

const keywords = {}, categories = {};
for (const [geo, lang] of Object.entries(GEO_LANG)) {
  const col = LANGS.indexOf(lang);
  if (col < 0) throw new Error(`нет переводов для языка ${lang} (гео ${geo})`);
  keywords[geo] = NICHES.map((row) => ({
    keyword: row[col + 1], lang, concept: row[0], intent_type: 'generic', weight: 1,
  }));
  categories[geo] = [...CATEGORIES];
}

const out = {
  _note: 'Семена на языке гео (ТЗ 3.2). concept — языконезависимый ключ ниши: по нему слой F ' +
    'сопоставляет одну и ту же нишу между гео. Файл генерируется tools/gen-seeds.js.',
  concepts: NICHES.map((row) => row[0]),
  keywords,
  apps: { US: [] },
  categories,
};
fs.writeFileSync(path.join(ROOT, 'config', 'seeds.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`семена: ${Object.keys(keywords).length} гео, ${NICHES.length} концептов, ` +
  `${Object.values(keywords).reduce((a, l) => a + l.length, 0)} ключей, ${CATEGORIES.length} категорий`);
