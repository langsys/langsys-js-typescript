export interface iLocaleFlat {
    code: string;
    name: string;
}

export interface iLocaleData {
    /** The locale code */
    code: string;
    /** Full locale name */
    locale_name: string;
    /** Language name only */
    lang_name: string;
}

export type iLanguageName = string;

/** `{ LanguageName: [{code, name}, ...] }` */
export type iLocaleDefault = Record<iLanguageName, iLocaleFlat[]>;
