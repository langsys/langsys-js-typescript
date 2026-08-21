export interface HttpResponse {
    status: number;
    statusText: string;
    url: string;
    data: string;
}

export interface ResponseObject {
    status: boolean;
    page?: number;
    page_count?: number;
    records_per_page?: number;
    data?: object[] | object;
    errors?: string[];
    http?: HttpResponse;

    /**
     * Server-computed write capability for this session, returned by
     * `authorize-project` and by every catalog fetch. Envelope-level on
     * `/translations`: the `data` member there IS the category map, so a stray
     * non-category key inside it would be read as a category.
     */
    write_enabled?: boolean;

    /** Catalog size counters returned alongside `data` on `/translations`. */
    words?: number;
    untranslated_words?: number;
}
