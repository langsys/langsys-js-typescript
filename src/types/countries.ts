export interface iCountry {
    /** Country name in the requested locale */
    label: string;
    /** ISO 3166-1 alpha-2 country code (e.g., "ES") */
    code: string;
    /** In the EU: VAT applies, and a business VAT ID makes it a reverse charge */
    eu?: boolean;
}

export type iCountryList = iCountry[];

export interface iCountryDialCode {
    /** ISO 3166-1 alpha-2 country code (e.g., "US", "CA", "GB") */
    country_code: string;
    /** International dialing code, digits only (e.g., "1", "44", "506") */
    dial_code: string;
    /** Country name in the requested locale with its dialing code (e.g., "Costa Rica (+506)") */
    name: string;
}
