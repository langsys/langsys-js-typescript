import { createSignal } from './signal.js';
import { persist } from './persist.js';
import type { iCategories } from './types/translations.js';
import type { iLangsysConfig } from './types/config.js';

const initialTranslations: iCategories = {
    __uncategorized__: {
        __category__: '__uncategorized__',
        __symbol__: '__uncategorized__',
    },
};

export const sTranslations = persist<iCategories>('translations', initialTranslations);

export const currentlyLoadedLocale = createSignal<string>('');

export const config: iLangsysConfig = {
    projectid: '',
    key: '',
    sUserLocale: createSignal<string>(''),
    baseLocale: 'en',
    debug: false,
    key_type: 'read',
};
