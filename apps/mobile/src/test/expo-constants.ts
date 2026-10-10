// Stand-in for expo-constants under vitest. The real module loads React
// Native, which Node cannot parse; tests only need "no app config present".
export default { expoConfig: undefined };
