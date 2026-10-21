/** Preview pangrams / test phrases for every Chrome Web Store locale (NFC). */

export const DIGITS = '0123456789';

export type ScriptCode =
  | 'Latn'
  | 'Cyrl'
  | 'Grek'
  | 'Arab'
  | 'Hebr'
  | 'Deva'
  | 'Beng'
  | 'Taml'
  | 'Telu'
  | 'Gujr'
  | 'Knda'
  | 'Mlym'
  | 'Thai'
  | 'Ethi'
  | 'Jpan'
  | 'Kore'
  | 'Hans'
  | 'Hant';

export interface SampleEntry {
  script: ScriptCode;
  text: string;
}

const en: SampleEntry = {
  script: 'Latn',
  text: 'The quick brown fox jumps over the lazy dog',
};
const es: SampleEntry = {
  script: 'Latn',
  text: 'El veloz murciélago hindú comía feliz cardillo y kiwi.',
};
const pt: SampleEntry = {
  script: 'Latn',
  text: 'Um pequeno jabuti xereta viu dez cegonhas felizes.',
};

/** One sample per public/_locales directory. */
export const SAMPLES = {
  am: {
    script: 'Ethi',
    text: 'የሰው፡ልጅ፡ሁሉ፡ሲወለድ፡ነጻና፡በክብርና፡በመብትም፡እኩልነት፡ያለው፡ነው።',
  },
  ar: {
    script: 'Arab',
    text: 'صف خلق خود كمثل الشمس إذ بزغت يحظى الضجيع بها نجلاء معطار',
  },
  bg: {
    script: 'Cyrl',
    text: 'Ах, чудна българска земьо, полюшвай цъфтящи жита.',
  },
  bn: {
    script: 'Beng',
    text: 'সমস্ত মানুষ স্বাধীনভাবে সমান মর্যাদা এবং অধিকার নিয়ে জন্মগ্রহণ করে।',
  },
  ca: {
    script: 'Latn',
    text: "Jove xef, porti whisky amb quinze glaçons d'hidrogen, coi!",
  },
  cs: {
    script: 'Latn',
    text: 'Příliš žluťoučký kůň úpěl ďábelské ódy.',
  },
  da: {
    script: 'Latn',
    text: 'Quizdeltagerne spiste jordbær med fløde, mens cirkusklovnen Walther spillede på xylofon.',
  },
  de: {
    script: 'Latn',
    text: 'Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich.',
  },
  el: {
    script: 'Grek',
    text: 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.',
  },
  en,
  en_AU: en,
  en_GB: en,
  en_US: en,
  es,
  es_419: es,
  et: {
    script: 'Latn',
    text: 'Põdur Zagrebi tšellomängija-följetonist Ciqo külmetas kehvas garaažis.',
  },
  // UDHR (pes); spelling modernised — needs native-speaker check
  fa: {
    script: 'Arab',
    text: 'تمام افراد بشر آزاد به دنیا می‌آیند و از لحاظ حیثیت و حقوق با هم برابرند.',
  },
  fi: {
    script: 'Latn',
    text: 'Charles Darwin jammaili Åken hevixylofonilla.',
  },
  fil: {
    script: 'Latn',
    text: "Ang lahat ng tao'y isinilang na malaya at pantay-pantay sa karangalan at mga karapatan.",
  },
  fr: {
    script: 'Latn',
    text: 'Portez ce vieux whisky au juge blond qui fume.',
  },
  gu: {
    script: 'Gujr',
    text: 'પ્રતિષ્ઠા અને અધિકારોની દૃષ્ટિએ સર્વ માનવો જન્મથી સ્વતંત્ર અને સમાન હોય છે.',
  },
  he: {
    script: 'Hebr',
    text: 'דג סקרן שט בים מאוכזב ולפתע מצא חברה',
  },
  hi: {
    script: 'Deva',
    text: 'सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता और समानता प्राप्त है।',
  },
  hr: {
    script: 'Latn',
    text: 'Gojazni đačić s biciklom drži hmelj i finu vatu u džepu nošnje.',
  },
  hu: {
    script: 'Latn',
    text: 'Jó foxim és don Quijote húszwattos lámpánál ülve egy pár bűvös cipőt készít.',
  },
  id: {
    script: 'Latn',
    text: 'Semua orang dilahirkan merdeka dan mempunyai martabat dan hak-hak yang sama.',
  },
  it: {
    script: 'Latn',
    text: 'Quel vituperabile xenofobo zelante assaggia il whisky ed esclama: alleluja!',
  },
  ja: {
    script: 'Jpan',
    text: 'あのイーハトーヴォのすきとおった風、夏でも底に冷たさをもつ青いそら',
  },
  kn: {
    script: 'Knda',
    text: 'ಎಲ್ಲಾ ಮಾನವರೂ ಸ್ವತಂತ್ರರಾಗಿಯೇ ಜನಿಸಿದ್ದಾರೆ. ಹಾಗೂ ಘನತೆ ಮತ್ತು ಹಕ್ಕುಗಳಲ್ಲಿ ಸಮಾನರಾಗಿದ್ದಾರೆ.',
  },
  ko: {
    script: 'Kore',
    text: '다람쥐 헌 쳇바퀴에 타고파',
  },
  lt: {
    script: 'Latn',
    text: 'Įlinkdama fechtuotojo špaga sublykčiojusi pragręžė apvalų arbūzą.',
  },
  lv: {
    script: 'Latn',
    text: 'Glāžšķūņa rūķīši dzērumā čiepj Baha koncertflīģeļu vākus.',
  },
  ml: {
    script: 'Mlym',
    // trailing U+200C kept from the UDHR source
    text: 'മനുഷ്യരെല്ലാവരും തുല്യാവകാശങ്ങളോടും അന്തസ്സോടും സ്വാതന്ത്ര്യത്തോടുംകൂടി ജനിച്ചിട്ടുള്ളവരാണ്‌.',
  },
  mr: {
    script: 'Deva',
    text: 'सर्व मानवी व्यक्ति जन्मतःच स्वतंत्र आहेत व त्यांना समान प्रतिष्ठा व समान अधिकार आहेत.',
  },
  ms: {
    script: 'Latn',
    text: 'Semua manusia dilahirkan bebas dan samarata dari segi kemuliaan dan hak-hak.',
  },
  nl: {
    script: 'Latn',
    text: "Pa's wijze lynx bezag vroom het fikse aquaduct.",
  },
  no: {
    script: 'Latn',
    text: 'Vår sære Zulu fra badeøya spilte jo whist og quickstep i min taxi.',
  },
  pl: {
    script: 'Latn',
    text: 'Pchnąć w tę łódź jeża lub ośm skrzyń fig.',
  },
  pt_BR: pt,
  pt_PT: pt,
  ro: {
    script: 'Latn',
    text: 'Muzicologă în bej vând whisky și tequila, preț fix.',
  },
  ru: {
    script: 'Cyrl',
    text: 'Съешь же ещё этих мягких французских булок, да выпей чаю',
  },
  sk: {
    script: 'Latn',
    text: 'Kŕdeľ šťastných ďatľov učí pri ústí Váhu mĺkveho koňa obhrýzať kôru a žrať čerstvé mäso.',
  },
  sl: {
    script: 'Latn',
    text: 'Šerif bo za vajo spet kuhal domače žgance.',
  },
  sr: {
    script: 'Cyrl',
    text: 'Ајшо, лепото и чежњо, за љубав срца мога дођи у Хаџиће на кафу.',
  },
  sv: {
    script: 'Latn',
    text: 'Flygande bäckasiner söka hwila på mjuka tuvor.',
  },
  sw: {
    script: 'Latn',
    text: 'Watu wote wamezaliwa huru, hadhi na haki zao ni sawa.',
  },
  // UDHR; source typo fixed — needs native-speaker check
  ta: {
    script: 'Taml',
    text: 'மனிதப் பிறவியினர் சகலரும் சுதந்திரமாகவே பிறக்கின்றனர்.',
  },
  te: {
    script: 'Telu',
    text: 'ప్రతిపత్తిస్వత్వముల విషయమున మానవులెల్లరును జన్మతః స్వతంత్రులును సమానులును నగుదురు.',
  },
  th: {
    script: 'Thai',
    text: 'มนุษย์ทั้งหลายเกิดมามีอิสระและเสมอภาคกันในเกียรติศักดิ์และสิทธิ',
  },
  tr: {
    script: 'Latn',
    text: 'Pijamalı hasta yağız şoföre çabucak güvendi.',
  },
  uk: {
    script: 'Cyrl',
    text: 'Чуєш їх, доцю, га? Кумедна ж ти, прощайся без ґольфів!',
  },
  vi: {
    script: 'Latn',
    text: 'Tất cả mọi người sinh ra đều được tự do và bình đẳng về nhân phẩm và quyền.',
  },
  zh_CN: {
    script: 'Hans',
    text: '天地玄黄 宇宙洪荒 日月盈昃 辰宿列张',
  },
  zh_TW: {
    script: 'Hant',
    text: '天地玄黃 宇宙洪荒 日月盈昃 辰宿列張',
  },
} as const satisfies Record<string, SampleEntry>;

export type LocaleId = keyof typeof SAMPLES;

const SAMPLE_BY_LOCALE: ReadonlyMap<string, SampleEntry> = new Map(Object.entries(SAMPLES));

export function sampleOf(locale: string): SampleEntry | undefined {
  return SAMPLE_BY_LOCALE.get(locale);
}
