export interface iContentBlock {
    custom_id: string;
    category: string;
    /**
     * The category this block was registered under before (MOVE-1): `''` for none,
     * absent when it did not move. Sent on its registration only; never part of
     * its `custom_id` (MOVE-2).
     */
    previousCategory?: string;
    content: string;
    label?: string;
    tokens: string[];
}
