export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  ProfileEdit: undefined;
  LeaveApply: undefined;
  AttendanceRegularize: undefined;
  Notifications: undefined;
  Announcements: undefined;
  Settings: undefined;
};

export type TabParamList = {
  Home: undefined;
  Leave: undefined;
  Attendance: undefined;
  Profile: undefined;
  More: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the standard react-navigation TypeScript augmentation pattern (https://reactnavigation.org/docs/typescript/), not an accidental empty type.
    interface RootParamList extends RootStackParamList {}
  }
}
