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
}
