interface iDirectToken {
    token: string;
    trans: string | null;
}

interface iDirectTokenTranslations {
    __DirectToken__?: iDirectToken;
}

export type iTranslations = iDirectTokenTranslations & {
    __category__: string;
    __symbol__: string;
    [key: string]: string;
};

export type iCategories = {
    [key: string]: iTranslations;
    __uncategorized__: iTranslations;
};
