import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { ProviderSetting } from "../api";
import type { PluginList } from "../api";
import { colors } from "../theme/tokens";
import { CustomPluginPage, PluginsPage } from "./PluginsPage";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconBack, IconCheck, IconChevron, IconClose, IconTrash } from "../ui/icons";

export type SignedAccount = {
  id: string;
  name: string;
  email: string;
};

export type MenuPage = "menu" | "account" | "signup" | "providers" | "plugins" | "plugin-custom";

/**
 * Shows the account menu, the account switcher, or signup.
 * Input: the signed-in accounts, the open page, and the menu actions.
 * Output: the sheet from the Grok menu screens.
 */
export function MenuSheet({
  page,
  account,
  accounts,
  notifications,
  autoReview,
  autoTimeZone,
  timeZone,
  providers,
  plugins,
  onClose,
  onPage,
  onNotifications,
  onAutoReview,
  onAutoTimeZone,
  onApprovals,
  onComputer,
  onSaveProvider,
  onAddPlugin,
  onRemovePlugin,
  onRefreshPlugins,
  onSaveCustomPlugin,
  onSignInCustomPlugin,
  onGoogle,
  onSwitch,
  onSignOut,
  onDelete,
}: {
  page: MenuPage;
  account: SignedAccount | null;
  accounts: SignedAccount[];
  notifications: boolean;
  autoReview: boolean;
  autoTimeZone: boolean;
  timeZone: string;
  providers: ProviderSetting[];
  plugins: PluginList | null;
  onClose: () => void;
  onPage: (page: MenuPage) => void;
  onNotifications: (value: boolean) => void;
  onAutoReview: (value: boolean) => void;
  onAutoTimeZone: (value: boolean) => void;
  onApprovals: () => void;
  onComputer: () => void;
  onSaveProvider: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => void;
  onAddPlugin: (id: string) => void;
  onRemovePlugin: (id: string) => void;
  onRefreshPlugins: () => void;
  onSaveCustomPlugin: (name: string, url: string, secret: string) => void;
  onSignInCustomPlugin: (name: string, url: string) => void;
  onGoogle: () => void;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <View style={styles.sheet}>
      {page === "menu" && account ? (
        <MenuPageView
          account={account}
          notifications={notifications}
          autoReview={autoReview}
          autoTimeZone={autoTimeZone}
          timeZone={timeZone}
          onClose={onClose}
          onAccount={() => onPage("account")}
          onNotifications={onNotifications}
          onAutoReview={onAutoReview}
          onAutoTimeZone={onAutoTimeZone}
          onApprovals={onApprovals}
          onComputer={onComputer}
          onProviders={() => onPage("providers")}
          onPlugins={() => onPage("plugins")}
        />
      ) : null}
      {page === "account" && account ? (
        <AccountPage
          account={account}
          accounts={accounts}
          onBack={() => onPage("menu")}
          onAdd={() => onPage("signup")}
          onSwitch={onSwitch}
          onSignOut={onSignOut}
          onDelete={() => onDelete(account.id)}
        />
      ) : null}
      {page === "signup" ? (
        <SignupPage
          accounts={accounts}
          onBack={account ? () => onPage("account") : onClose}
          onGoogle={onGoogle}
          onSwitch={onSwitch}
        />
      ) : null}
      {page === "plugins" ? (
        <PluginsPage
          plugins={plugins}
          onBack={() => onPage("menu")}
          onCustom={() => onPage("plugin-custom")}
          onAdd={onAddPlugin}
          onRemove={onRemovePlugin}
          onRefresh={onRefreshPlugins}
        />
      ) : null}
      {page === "plugin-custom" ? (
        <CustomPluginPage onBack={() => onPage("plugins")} onSave={onSaveCustomPlugin} onSignIn={onSignInCustomPlugin} />
      ) : null}
      {page === "providers" ? (
        <ProviderPage
          providers={providers}
          onBack={() => onPage("menu")}
          onSave={onSaveProvider}
        />
      ) : null}
    </View>
  );
}

function MenuPageView({
  account,
  notifications,
  autoReview,
  autoTimeZone,
  timeZone,
  onClose,
  onAccount,
  onNotifications,
  onAutoReview,
  onAutoTimeZone,
  onApprovals,
  onComputer,
  onProviders,
  onPlugins,
}: {
  account: SignedAccount;
  notifications: boolean;
  autoReview: boolean;
  autoTimeZone: boolean;
  timeZone: string;
  onClose: () => void;
  onAccount: () => void;
  onNotifications: (value: boolean) => void;
  onAutoReview: (value: boolean) => void;
  onAutoTimeZone: (value: boolean) => void;
  onApprovals: () => void;
  onComputer: () => void;
  onProviders: () => void;
  onPlugins: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <CircleButton label="Close menu" onPress={onClose}>
        <IconClose />
      </CircleButton>
      <Pressable accessibilityRole="button" onPress={onAccount} style={styles.card}>
        <Avatar id={account.id} size={44} person />
        <View style={styles.cardBody}>
          <Text style={styles.name}>{account.name}</Text>
          <Text style={styles.email}>{account.email}</Text>
        </View>
        <IconChevron />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onApprovals} style={styles.card}>
        <Text style={styles.rowLabel}>Usage</Text>
        <IconChevron />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onProviders} style={styles.card}>
        <View style={styles.cardBody}>
          <Text style={styles.rowLabel}>AI Providers</Text>
          <Text style={styles.hint}>API keys and local OpenAI-compatible models</Text>
        </View>
        <IconChevron />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onPlugins} style={styles.card}>
        <View style={styles.cardBody}>
          <Text style={styles.rowLabel}>Plugins</Text>
          <Text style={styles.hint}>Gmail, Calendar, Drive, and your own MCP servers</Text>
        </View>
        <IconChevron />
      </Pressable>
      <Text style={styles.section}>Bot</Text>
      <View style={styles.group}>
        <View style={styles.groupRow}>
          <View style={styles.cardBody}>
            <Text style={styles.rowLabel}>Auto-review</Text>
            <Text style={styles.hint}>Require approval for risky shell, MCP, and computer actions.</Text>
          </View>
          <Switch value={autoReview} onValueChange={onAutoReview} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <Pressable accessibilityRole="button" onPress={onApprovals} style={styles.groupRow}>
          <Text style={styles.rowLabel}>Auto-review Rules</Text>
          <View style={styles.trailing}>
            <Text style={styles.trailingText}>Approvals</Text>
            <IconChevron />
          </View>
        </Pressable>
        <View style={styles.groupRow}>
          <View style={styles.cardBody}>
            <Text style={styles.rowLabel}>Set Time Zone Automatically</Text>
            <Text style={styles.hint}>Your Bot's computer follows this device's time zone.</Text>
          </View>
          <Switch value={autoTimeZone} onValueChange={onAutoTimeZone} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <View style={styles.groupRow}>
          <Text style={styles.rowLabel}>Time Zone</Text>
          <Text style={styles.trailingText}>{timeZone}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onComputer} style={styles.groupRow}>
          <Text style={styles.rowLabel}>Bot Computer</Text>
          <IconChevron />
        </Pressable>
      </View>
      <View style={styles.group}>
        <View style={styles.groupRow}>
          <Text style={styles.rowLabel}>Notifications</Text>
          <Switch value={notifications} onValueChange={onNotifications} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <View style={styles.groupRow}>
          <Text style={styles.rowLabel}>Appearance</Text>
          <View style={styles.trailing}>
            <Text style={styles.trailingText}>System · Black</Text>
            <IconChevron />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const providerNames: ProviderSetting["provider"][] = ["openai", "anthropic", "xai", "local"];

/**
 * Edits encrypted account-scoped provider credentials.
 * Input: configured providers and the save action.
 * Output: a provider picker with a secret field and local base URL.
 */
function ProviderPage({
  providers,
  onBack,
  onSave,
}: {
  providers: ProviderSetting[];
  onBack: () => void;
  onSave: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => void;
}) {
  const [provider, setProvider] = useState<ProviderSetting["provider"]>("openai");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const configured = providers.find((row) => row.provider === provider);

  useEffect(() => {
    setSecret("");
    setBaseUrl(configured?.baseUrl ?? "");
  }, [configured?.baseUrl, provider]);

  const ready = provider === "local" ? baseUrl.trim().length > 0 : secret.trim().length > 0 || configured?.configured;
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.accountHeader}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.accountTitle}>AI Providers</Text>
      </View>
      <Text style={styles.hint}>Keys are encrypted on the server and never returned to this phone.</Text>
      <View style={styles.group}>
        {providerNames.map((name) => (
          <Pressable key={name} accessibilityRole="button" onPress={() => setProvider(name)} style={styles.groupRow}>
            <Text style={styles.rowLabel}>{name === "xai" ? "xAI" : name[0]?.toUpperCase() + name.slice(1)}</Text>
            {providers.some((row) => row.provider === name && row.configured) ? <Text style={styles.configured}>Configured</Text> : null}
            {provider === name ? <IconCheck /> : null}
          </Pressable>
        ))}
      </View>
      <TextInput
        value={secret}
        onChangeText={setSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        placeholder={configured?.configured ? "Leave blank to keep current key" : provider === "local" ? "Optional local key" : "API key"}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      {provider === "local" ? (
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          placeholder="https://your-openai-compatible-server/v1"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={() => onSave(provider, secret, provider === "local" ? baseUrl.trim() : null)}
        style={[styles.primary, !ready && styles.disabled]}
      >
        <Text style={styles.primaryText}>Save provider</Text>
      </Pressable>
    </ScrollView>
  );
}

function AccountPage({
  account,
  accounts,
  onBack,
  onAdd,
  onSwitch,
  onSignOut,
  onDelete,
}: {
  account: SignedAccount;
  accounts: SignedAccount[];
  onBack: () => void;
  onAdd: () => void;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onDelete: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.accountHeader}>
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
        <Text style={styles.accountTitle}>Account</Text>
      </View>
      <View style={styles.card}>
        <Avatar id={account.id} size={44} person />
        <View style={styles.cardBody}>
          <Text style={styles.name}>{account.name}</Text>
          <Text style={styles.email}>{account.email}</Text>
        </View>
      </View>
      <Text style={styles.section}>Switch Account</Text>
      <View style={styles.group}>
        {accounts.map((row) => (
          <Pressable key={row.id} accessibilityRole="button" onPress={() => onSwitch(row.id)} style={styles.groupRow}>
            <Text style={styles.rowLabel}>{row.email}</Text>
            {row.id === account.id ? <IconCheck /> : null}
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" onPress={onAdd} style={styles.groupRow}>
          <Text style={styles.rowLabel}>+  Add Account</Text>
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.dangerButton}>
        <Text style={styles.dangerText}>Sign Out</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onDelete} style={styles.dangerButton}>
        <IconTrash />
        <Text style={styles.dangerText}>Delete Account</Text>
      </Pressable>
      <Text style={styles.caption}>Removes this account from the phone. This can't be undone here.</Text>
    </ScrollView>
  );
}

/**
 * Starts Google sign-in on the core.
 * Input: accounts already on this phone, and the Google and switch handlers.
 * Output: the sign-in page. The account id comes back from the Google session.
 */
function SignupPage({
  accounts,
  onBack,
  onGoogle,
  onSwitch,
}: {
  accounts: SignedAccount[];
  onBack?: () => void;
  onGoogle: () => void;
  onSwitch: (id: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {onBack ? (
        <CircleButton label="Back" onPress={onBack}>
          <IconBack />
        </CircleButton>
      ) : null}
      <Text style={styles.signupTitle}>Sign in</Text>
      <Text style={styles.hint}>Google creates your account. Chats and groups use that account id.</Text>
      <Pressable accessibilityRole="button" onPress={onGoogle} style={styles.primary}>
        <Text style={styles.primaryText}>Continue with Google</Text>
      </Pressable>
      {accounts.length > 0 ? <Text style={styles.section}>On this phone</Text> : null}
      {accounts.map((row) => (
        <Pressable key={row.id} accessibilityRole="button" onPress={() => onSwitch(row.id)} style={styles.card}>
          <Text style={styles.rowLabel}>{row.email}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheet, borderRadius: 28, overflow: "hidden" },
  scroll: { padding: 14, paddingBottom: 28, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  cardBody: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  email: { color: colors.muted, fontSize: 14 },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  section: { color: colors.muted, fontSize: 13, marginTop: 8, marginLeft: 6 },
  group: { backgroundColor: colors.card, borderRadius: 16, overflow: "hidden" },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  trailing: { flexDirection: "row", alignItems: "center", gap: 6 },
  trailingText: { color: colors.muted, fontSize: 15 },
  configured: { color: colors.green, fontSize: 13 },
  accountHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  accountTitle: { color: colors.text, fontSize: 20, fontWeight: "600" },
  dangerButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: 16,
    height: 52,
  },
  dangerText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 6 },
  signupTitle: { color: colors.text, fontSize: 28, fontWeight: "700", marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 14,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  primary: { backgroundColor: colors.text, borderRadius: 22, height: 48, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
