// Masters shared across modules, and the platform's own configurable records.
import { define } from '../engine/registry.js';

const OFFICE = ['ADMIN', 'MANAGEMENT'];
const by = (...roles) => ({ writers: [...OFFICE, ...roles] });
const m = (name, fields, extra = {}) => define({ name, module: 'setup', fields, readers: 'all', ...extra });
const tree = (name, fields, extra = {}) => m(name, `${fields} parentId:link(${name}) isGroup:check`, { tree: true, ...extra });

m('FiscalYear', 'name!* startDate!:date endDate!:date isClosed~:check', { list: 'name startDate endDate isClosed', ...by('ACCOUNTS') });
m('Currency', 'code!* name symbol fractionUnits:int=100 isActive:check=true');
m('CurrencyExchange', 'fromCurrency! toCurrency!=INR rateFx4!:fx onDate!:date', { list: 'fromCurrency toCurrency rateFx4 onDate', labelFields: ['fromCurrency', 'onDate'], dateField: 'onDate', ...by('ACCOUNTS', 'SALES', 'PURCHASE') });
m('Uom', 'name!* mustBeWhole:check isActive:check=true', by('STORES', 'PURCHASE', 'ENGINEERING'));
m('UomConversion', 'fromUom!:link(Uom) toUom!:link(Uom) factorMilli!:qty', { labelFields: ['fromUom'], ...by('STORES', 'PURCHASE', 'ENGINEERING') });
m('Brand', 'name!* description:long', by('STORES', 'PURCHASE', 'SALES', 'ENGINEERING'));
tree('ItemGroup', 'name!* defaultWarehouseId:link(Warehouse)', by('STORES', 'PURCHASE', 'ENGINEERING'));
tree('CustomerGroup', 'name!* defaultCreditDays:int', by('SALES', 'ACCOUNTS'));
tree('SupplierGroup', 'name!* defaultCreditDays:int', by('PURCHASE', 'ACCOUNTS'));
tree('Territory', 'name!* managerId:link(User)', by('SALES'));
tree('SalesPerson', 'name!* employeeId:link(Employee) commissionBps:pct targetPaise:money', by('SALES'));
m('SalesPartner', 'name!* partnerType territoryId:link(Territory) commissionBps:pct email:email phone:phone', by('SALES'));
tree('Department', 'name!* headId:link(Employee) payrollCostCenterId:link(CostCenter) leaveApproverId:link(User) expenseApproverId:link(User)', by('HR'));
m('Designation', 'name!* description:long', by('HR'));
m('Branch', 'name!* address:long gstin', by('HR', 'ACCOUNTS'));
m('Plant', 'name!* address:long gstin stateCode');
m('HolidayList', 'name!* fromDate!:date toDate!:date weeklyOff:select(SUNDAY,SATURDAY,FRIDAY,NONE)=SUNDAY', { tables: { holidays: 'onDate!:date description' }, list: 'name fromDate toDate weeklyOff', ...by('HR') });
m('TermsAndConditions', 'title!* terms!:long forSelling:check=true forBuying:check=true isActive:check=true', { list: 'title forSelling forBuying isActive', ...by('SALES', 'PURCHASE') });
m('Incoterm', 'code!* description', by('SALES', 'PURCHASE'));
m('Driver', 'name!* licenseNo licenseExpiry:date phone:phone employeeId:link(Employee) isActive:check=true', { list: 'name licenseNo licenseExpiry phone', ...by('STORES', 'HR') });
m('Vehicle', 'registrationNo!* make model fuelType:select(PETROL,DIESEL,CNG,ELECTRIC) insuranceExpiry:date employeeId:link(Employee) odometer:int', { list: 'registrationNo make model insuranceExpiry', ...by('STORES', 'HR') });
m('Location', 'name!* parentId:link(Location) address:long', { tree: true, ...by('ACCOUNTS', 'STORES') });
m('Address', 'title! kind:select(BILLING,SHIPPING,OFFICE,PLANT)=BILLING partyId:link(Party) line1! line2 city state stateCode pincode country=India gstin isPrimary:check', { list: 'title kind city state country', searchFields: ['title', 'city', 'pincode', 'gstin'], ...by('SALES', 'PURCHASE', 'ACCOUNTS', 'SERVICE') });
m('Contact', 'firstName! lastName partyId:link(Party) designation email:email phone:phone mobile:phone isPrimary:check', { list: 'firstName lastName email mobile', searchFields: ['firstName', 'lastName', 'email', 'mobile'], labelFields: ['firstName', 'lastName'], ...by('SALES', 'PURCHASE', 'ACCOUNTS', 'SERVICE') });
m('PrintHeading', 'name!* description');
m('LetterHead', 'name!* headerText:long footerText:long isDefault:check');
m('AuthorizationRule', 'name!* doctypeName! basedOn:select(GRAND_TOTAL,DISCOUNT_PERCENT)=GRAND_TOTAL approvingRole! limitPaise:money');
m('EmailDigest', 'name!* recipients!:long frequency:select(DAILY,WEEKLY,MONTHLY)=DAILY includeSales:check=true includePurchases:check=true includeReceivables:check=true isActive:check=true nextOn:date', { list: 'name frequency isActive nextOn' });

// A rule that tells people when something happens to a document.
define({ name: 'NotificationRule', module: 'platform', fields: 'name!* doctypeName! event:select(CREATED,SUBMITTED,CANCELLED)=SUBMITTED role sendEmail:check isActive:check=true', list: 'name doctypeName event role isActive' });

// A document can have a path of approvals before it can be submitted.
define({
  name: 'Workflow',
  module: 'platform',
  fields: 'name!* doctypeName!* startState!=Draft approvedState!=Approved isActive:check=true',
  tables: { transitions: 'fromState! action! toState! role!' },
  list: 'name doctypeName startState approvedState isActive',
});

// Makes a fresh draft of a document on a schedule, like a monthly invoice.
define({
  name: 'AutoRepeat',
  module: 'platform',
  fields: 'name!* doctypeName! sourceId! frequency:select(DAILY,WEEKLY,MONTHLY,QUARTERLY,YEARLY)=MONTHLY startDate!:date endDate:date nextDate:date isActive:check=true',
  list: 'name doctypeName frequency nextDate isActive',
});
