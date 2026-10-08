import type { ViewStyle } from "react-native";

/**
 * Lets a form-sheet list fill the space under the navigation bar and scroll.
 * Input: none. The sheet detent gives the list its height.
 * Output: a flex frame for the sheet ScrollView.
 */
export function useSheetScrollStyle(): ViewStyle {
  return { flex: 1 };
}
