import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useKeyboardInset } from "./useKeyboardInset";

/** Keeps bottom inputs above the keyboard on iOS (KAV) and Android (IME padding). */
export function AppKeyboardShell({ children }: { children: ReactNode }) {
  const keyboardInset = useKeyboardInset();

  if (Platform.OS === "ios") {
    return (
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {children}
      </KeyboardAvoidingView>
    );
  }

  return <View style={[styles.flex, keyboardInset > 0 ? { paddingBottom: keyboardInset } : null]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
