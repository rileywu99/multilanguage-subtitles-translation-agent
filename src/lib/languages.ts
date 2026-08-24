export type TargetLanguage = {
  code: string;
  name: string;
};

export const COMMON_LANGUAGES: TargetLanguage[] = [
  { code: "en", name: "English (USA)" },
  { code: "zh-TW", name: "Chinese (Traditional)" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "ja", name: "Japanese" },
];
