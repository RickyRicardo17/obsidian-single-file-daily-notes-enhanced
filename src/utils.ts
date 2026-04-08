import { Moment } from "moment";
import { App, moment, TFile } from "obsidian";

import { PluginSettings } from "./settings";

/**
 * Returns the path for the daily notes file
 */
export const getDailyNotesFilePath = (settings: PluginSettings) => {
    const file = settings.noteName + ".md";

    if (settings.noteLocation == "") {
        return file;
    } else {
        return settings.noteLocation + "/" + file;
    }
};

/**
 * Returns the daily notes file
 */
export const getDailyNotesFile = (
    app: App,
    settings: PluginSettings,
): TFile | null => {
    const path = getDailyNotesFilePath(settings);
    const file = app.vault.getAbstractFileByPath(path);

    if (file && file instanceof TFile) {
        return file;
    } else {
        return null;
    }
};

/**
 * Returns the level of headingType from settings
 * @example
 * getHeadingLevel({headingType: "h3"})
 * // Returns 3
 */
export const getHeadingLevel = (settings: PluginSettings): number => {
    return parseInt(settings.headingType[1]);
};

/**
 * Generates the Markdown for a heading
 * @example
 * getHeadingMd({headingType: "h3"})
 * // Returns ###
 */
export const getHeadingMd = (settings: PluginSettings): string => {
    return "#".repeat(getHeadingLevel(settings));
};

/**
 * Generates a daily note section heading for a date
 * @example
 * getHeadingForDate({headingType: "h3", dateFormat: "DD-MM-YYYY, dddd"}, date(29-05-24))
 * // Returns ### 29-05-2024, Wednesday
 */
export const getHeadingForDate = (
    settings: PluginSettings,
    date: Moment,
): string => {
    return getHeadingMd(settings) + " " + date.format(settings.dateFormat);
};

/**
 * Generates a daily note section heading for today.
 *
 * See {@link getHeadingForDate}
 */
export const getTodayHeading = (settings: PluginSettings): string => {
    return getHeadingForDate(settings, moment());
};

/**
 * Returns the default entry text as written into new daily note sections.
 * When useCheckboxes is on, bullet lines (- or *) become task items (- [ ] …).
 */
export const getEffectiveNoteEntry = (settings: PluginSettings): string => {
    if (!settings.useCheckboxes) {
        return settings.noteEntry;
    }

    return settings.noteEntry
        .split("\n")
        .map((line) => {
            const match = /^(\s*)([-*])(\s+)(.*)$/.exec(line);
            if (!match) {
                return line;
            }

            const rest = match[4];
            if (/^\[[ xX]\]\s/.test(rest)) {
                return line;
            }

            return `${match[1]}${match[2]}${match[3]}[ ] ${rest}`;
        })
        .join("\n");
};

export const getSectionForDate = (
    settings: PluginSettings,
    date: Moment,
    entryBody?: string,
): string => {
    const body = entryBody ?? getEffectiveNoteEntry(settings);
    return getHeadingForDate(settings, date) + "\n" + body;
};

/** Unchecked Markdown task line (- or * with `[ ]`). */
const UNCHECKED_TASK_LINE = /^\s*[-*]\s+\[ \]\s*(.*)$/;

/**
 * Parses the date portion of a daily heading label (text after `### ` etc.).
 * Tries strict format first, then loose — matches how headings are produced
 * and avoids missing rollovers when strict parsing fails.
 */
const parseDailyDateLabel = (
    label: string,
    settings: PluginSettings,
): Moment | null => {
    let m = moment(label, settings.dateFormat, true);
    if (m.isValid()) {
        return m;
    }
    m = moment(label, settings.dateFormat);
    return m.isValid() ? m : null;
};

const parseDailyHeadingLineDate = (
    line: string,
    settings: PluginSettings,
): Moment | null => {
    const prefix = getHeadingMd(settings) + " ";
    if (!line.startsWith(prefix)) {
        return null;
    }
    return parseDailyDateLabel(line.slice(prefix.length), settings);
};

/**
 * Section to roll tasks from: prefer latest calendar day before `targetDate`;
 * if none (e.g. only future-dated sections exist), use the earliest day after
 * `targetDate` so planning ahead / backfilling still gets a neighbor section.
 */
const findRolloverSourceHeadingLine = (
    lines: string[],
    targetDate: Moment,
    settings: PluginSettings,
    scanFrom: number,
): number | null => {
    const headingMd = getHeadingMd(settings);
    const prefix = headingMd + " ";

    let bestBeforeLine: number | null = null;
    let bestBefore: Moment | null = null;
    let bestAfterLine: number | null = null;
    let bestAfter: Moment | null = null;

    for (let i = scanFrom; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith(prefix)) {
            continue;
        }

        const lineDate = parseDailyDateLabel(
            line.slice(prefix.length),
            settings,
        );
        if (!lineDate) {
            continue;
        }

        if (lineDate.isSame(targetDate, "day")) {
            continue;
        }

        if (lineDate.isBefore(targetDate, "day")) {
            if (
                bestBefore === null ||
                lineDate.isAfter(bestBefore, "day")
            ) {
                bestBefore = lineDate;
                bestBeforeLine = i;
            }
        } else if (lineDate.isAfter(targetDate, "day")) {
            if (
                bestAfter === null ||
                lineDate.isBefore(bestAfter, "day")
            ) {
                bestAfter = lineDate;
                bestAfterLine = i;
            }
        }
    }

    if (bestBeforeLine !== null) {
        return bestBeforeLine;
    }
    return bestAfterLine;
};

/**
 * Body lines for a daily section: from just after the heading until the next
 * valid daily date heading at the same level.
 */
const getDailySectionBodyLines = (
    lines: string[],
    headingLineIndex: number,
    settings: PluginSettings,
): string[] => {
    const headingMd = getHeadingMd(settings);
    const prefix = headingMd + " ";
    const body: string[] = [];

    for (let i = headingLineIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(prefix)) {
            const label = line.slice(prefix.length);
            if (parseDailyDateLabel(label, settings)) {
                break;
            }
        }
        body.push(line);
    }

    return body;
};

/**
 * Unchecked task lines to carry into a new day (order preserved).
 */
const extractRolloverTaskLines = (sectionLines: string[]): string[] => {
    return sectionLines.filter((line) => UNCHECKED_TASK_LINE.test(line));
};

const buildEntryBodyWithRollover = (
    settings: PluginSettings,
    fileLines: string[],
    targetDate: Moment,
    contentStartLine: number,
): string => {
    const defaultEntry = getEffectiveNoteEntry(settings);
    if (!settings.rolloverPreviousDayNotes) {
        return defaultEntry;
    }

    const sourceHeading = findRolloverSourceHeadingLine(
        fileLines,
        targetDate,
        settings,
        contentStartLine,
    );
    if (sourceHeading === null) {
        return defaultEntry;
    }

    const sectionBody = getDailySectionBodyLines(
        fileLines,
        sourceHeading,
        settings,
    );
    const rolled = extractRolloverTaskLines(sectionBody);
    if (rolled.length === 0) {
        return defaultEntry;
    }

    return rolled.join("\n") + "\n" + defaultEntry;
};

export const getSectionForMonth = (
    settings: PluginSettings,
    date: Moment,
): string => {
    const monthHeading =
        "#".repeat(getHeadingLevel(settings) - 1) +
        " " +
        date.format(settings.monthFormat);

    return "\n" + "---\n" + monthHeading;
};

export const insertNoteForDate = (
    fileContent: string,
    date: moment.Moment,
    settings: PluginSettings,
): [string, number] => {
    const lines = fileContent.split("\n");

    const headingMd = getHeadingMd(settings);
    let encounteredLaterDate = false;

    // Offset start index if properties are present
    let i = 0;
    if (lines[0] == "---") {
        i++;
        while (lines[i] != "---") {
            i++;
        }
        i++;
    }

    const startIndex = i;

    const entryBody = buildEntryBodyWithRollover(
        settings,
        lines,
        date,
        startIndex,
    );
    let note = getSectionForDate(settings, date, entryBody);

    while (i < lines.length) {
        const line = lines[i];

        if (!line.startsWith(headingMd)) {
            i++;
            continue;
        }

        const lineDate = parseDailyHeadingLineDate(line, settings);

        if (!lineDate) {
            i++;
            continue;
        }

        if (lineDate.isAfter(date, "day")) {
            encounteredLaterDate = true;
            i++;
            continue;
        }

        if (lineDate.isSame(date, "day")) {
            return [fileContent, i];
        }

        if (lineDate.isBefore(date, "day")) {
            if (
                lineDate.month() < date.month() ||
                lineDate.year() < date.year()
            ) {
                note += "\n" + getSectionForMonth(settings, lineDate);
            }

            lines.splice(i, 0, note);
            return [lines.join("\n"), i];
        }

        i++;
    }

    if (encounteredLaterDate) {
        lines.push(note);
        return [lines.join("\n"), lines.length];
    }

    lines.splice(startIndex, 0, note);
    return [lines.join("\n"), startIndex];
};
