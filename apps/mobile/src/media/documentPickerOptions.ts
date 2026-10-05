import type { DocumentPickerOptions } from "expo-document-picker";

/** System document picker (Files on iOS, Storage Access Framework on Android). */
export function documentPickerOptions(): DocumentPickerOptions {
  return {
    copyToCacheDirectory: true,
    multiple: false,
  };
}
