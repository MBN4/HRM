import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nProvider, useI18n } from './src/i18n/I18nContext';
import { useRtlSync } from './src/i18n/useRtlSync';
import { AuthProvider } from './src/lib/auth/AuthContext';
import { BrandingProvider } from './src/theme/BrandingContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { configureNotificationHandler } from './src/lib/push';
import './src/navigation/types';

configureNotificationHandler();

/**
 * Applies the RTL native-layout sync (see src/i18n/useRtlSync.ts) once the
 * i18n layer's locale is resolved (`ready`) — split into its own component
 * (rather than inlined in <App>) purely so it can call `useI18n()`, which
 * requires being a descendant of `<I18nProvider>`.
 */
function RtlGate({ children }: { children: React.ReactNode }) {
  const { locale, ready } = useI18n();
  useRtlSync(ready ? locale === 'ar' : null);
  return <>{children}</>;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <RtlGate>
          <AuthProvider>
            <BrandingProvider>
              <NavigationContainer>
                <StatusBar style="dark" />
                <RootNavigator />
              </NavigationContainer>
            </BrandingProvider>
          </AuthProvider>
        </RtlGate>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
