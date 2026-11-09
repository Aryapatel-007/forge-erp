import { Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { Shell } from './components/Shell.jsx';
import { NotFoundPage } from './components/NotFoundPage.jsx';
import { Spinner } from './components/ui.jsx';
import { useAuth } from './context/Auth.jsx';
import { LoginPage } from './features/LoginPage.jsx';
import { AppHomePage, AppsPage, DepartmentPreview, DepartmentsPage, HomePage } from './features/HomePage.jsx';
import { BuildPage } from './features/BuildPage.jsx';
import { FatPage } from './features/FatPage.jsx';
import { ReportPage, ReportsIndex } from './features/ReportsPage.jsx';
import { AuditPage, PasswordPage, SettingsPage, UsersPage } from './features/AdminPages.jsx';
import { ListPage } from './features/generic/ListPage.jsx';
import { FormPage } from './features/generic/FormPage.jsx';
import { DetailPage } from './features/generic/DetailPage.jsx';
import { PrintPage } from './features/generic/PrintPage.jsx';
import { LegacyModuleRedirect, MyWorkPage, SearchPage } from './features/ModulePage.jsx';
import { ReportBuilder, ReportRunner } from './features/ReportRunner.jsx';
import { CustomFieldsPage, RolePermissionsPage, SystemPage } from './features/PlatformAdmin.jsx';
import { DashboardsPage, DashboardView } from './features/DashboardsPage.jsx';
import { PortalApp } from './features/PortalApp.jsx';
import { PublicFormPage } from './features/PublicFormPage.jsx';
import { SetupGuide } from './features/SetupGuide.jsx';
import { VaultAdminPage, VaultFilePage, VaultPage } from './features/VaultPages.jsx';
import { FeaturesPage, MaintainerHome, RoleScreenPage, RolesPage } from './features/MaintainerPages.jsx';
import { SitePage } from './features/SitePages.jsx';

export function App() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  // A public form is for people with no sign-in at all.
  if (location.pathname.startsWith('/form/')) return <Routes><Route path="/form/:slug" element={<PublicFormPage />} /></Routes>;
  if (location.pathname === '/site' || location.pathname.startsWith('/site/')) return <Routes><Route path="/site" element={<SitePage />} /><Route path="/site/:slug" element={<SitePage />} /></Routes>;
  if (isLoading) return <Spinner label="Starting" />;
  if (!user) return <LoginPage />;
  if (user.role === 'PORTAL') return <PortalApp />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="apps" element={<AppsPage />} />
        <Route path="departments" element={<DepartmentsPage />} />
        <Route path="dept/:role" element={<DepartmentPreview />} />
        <Route path="app/:app" element={<AppHomePage />} />
        <Route path="app/:app/:tab" element={<AppHomePage />} />
        <Route path="builds/:id" element={<BuildPage />} />
        <Route path="fat/:id" element={<FatPage />} />
        <Route path="reports" element={<ReportsIndex />} />
        <Route path="reports/:report" element={<ReportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="password" element={<PasswordPage />} />
        <Route path="m/:module" element={<LegacyModuleRedirect />} />
        <Route path="rep/:key" element={<ReportRunner />} />
        <Route path="report-builder" element={<ReportBuilder />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="my-work" element={<MyWorkPage />} />
        <Route path="custom-fields" element={<CustomFieldsPage />} />
        <Route path="role-permissions" element={<RolePermissionsPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="dash" element={<DashboardsPage />} />
        <Route path="dash/:id" element={<DashboardView />} />
        <Route path="going-live" element={<SetupGuide />} />
        <Route path="vault" element={<VaultPage />} />
        <Route path="vault/admin" element={<VaultAdminPage />} />
        <Route path="vault/setup" element={<Navigate to="/vault/admin" replace />} />
        <Route path="maintainer" element={<MaintainerHome />} />
        <Route path="maintainer/features" element={<FeaturesPage />} />
        <Route path="maintainer/roles" element={<RolesPage />} />
        <Route path="maintainer/roles/:role" element={<RoleScreenPage />} />
        <Route path="vault/:id" element={<VaultFilePage />} />
        <Route path="print/:resource/:id" element={<PrintPage />} />
        <Route path=":resource" element={<ListPage />} />
        <Route path=":resource/new" element={<FormPage />} />
        <Route path=":resource/:id" element={<DetailPage />} />
        <Route path=":resource/:id/edit" element={<FormPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
