import type { NativeStackNavigationOptions } from "expo-router";
import { colors } from "../theme/tokens";

/**
 * iOS presents a native form sheet. Android presents a normal full-screen page,
 * which is how Material handles a multi-field form.
 * Input: the navigation title.
 * Output: stack options for that screen.
 */
export function sheetScreenOptions(
  title: string,
  detents: number[] | "fitToContents" = [0.92],
): NativeStackNavigationOptions {
  const shared: NativeStackNavigationOptions = {
    title,
    headerStyle: { backgroundColor: colors.sheet },
    contentStyle: { backgroundColor: colors.sheet },
  };
  if (process.env.EXPO_OS !== "ios") return shared;
  return {
    ...shared,
    presentation: "formSheet",
    sheetGrabberVisible: true,
    sheetAllowedDetents: detents,
    sheetExpandsWhenScrolledToEdge: false,
  };
}
