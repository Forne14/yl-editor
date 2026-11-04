/**
 * Every word the chrome shows. Hosts translate or reword by passing `strings` to `mountEditor`; placeholders in
 * braces are filled by `format`.
 */
export declare const defaultStrings: {
    editThisPage: string;
    editingRegion: string;
    draftsSaveAsYouGo: string;
    noChanges: string;
    oneChange: string;
    changes: string;
    changesAcross: string;
    othersNeedPublisher: string;
    reloadToSee: string;
    actionFailed: string;
    done: string;
    discard: string;
    publish: string;
    revisions: string;
    close: string;
    cancel: string;
    confirm: string;
    retry: string;
    saving: string;
    saved: string;
    saveFailed: string;
    networkError: string;
    loadFailed: string;
    notEditable: string;
    unknownDocument: string;
    pressEnterToEdit: string;
    noWidget: string;
    richtextFallback: string;
    conflict: string;
    keepMine: string;
    takeTheirs: string;
    publishTitle: string;
    discardTitle: string;
    nothingToPublish: string;
    nothingToDiscard: string;
    published: string;
    discarded: string;
    revisionsTitle: string;
    noRevisions: string;
    revisionLine: string;
    unknownActor: string;
    chooseDocument: string;
    addTag: string;
    removeTag: string;
    yes: string;
    no: string;
};
export type Strings = typeof defaultStrings;
export declare function format(template: string, values: Record<string, string | number>): string;
//# sourceMappingURL=strings.d.ts.map