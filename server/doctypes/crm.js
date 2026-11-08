// CRM: the journey before a quotation.
import { define, modelOf } from '../engine/registry.js';
import { createDoc } from '../engine/documents.js';
import { rule } from '../utils/errors.js';
import { Party } from '../models/masters.js';
import { Counter } from '../models/core.js';

const m = (name, fields, extra = {}) => define({ name, module: 'crm', fields, ...extra });

m('LeadSource', 'name!* details:long');
m('MarketSegment', 'name!*');
m('SalesStage', 'name!* probabilityBps:pct order:int');
m('OpportunityType', 'name!*');
m('OpportunityLostReason', 'name!*');
m('Competitor', 'name!* website notes:long');

async function nextPartyCode(session, prefix) {
  const counter = await Counter.findOneAndUpdate({ _id: `partycode:${prefix}` }, { $inc: { seq: 1 } }, { session, upsert: true, new: true });
  return `${prefix}-${String(counter.seq).padStart(5, '0')}`;
}

define({
  name: 'Lead',
  module: 'crm',
  series: 'LD',
  fields: 'leadName! companyName email:email mobile:phone phone:phone website city state country=India sourceId:link(LeadSource) campaignId:link(Campaign) marketSegmentId:link(MarketSegment) industry ownerId:link(User) status:select(NEW,CONTACTED,INTERESTED,REPLIED,QUALIFIED,CONVERTED,LOST,DO_NOT_CONTACT)=NEW requirement:long nextContactOn:date convertedPartyId~:link(Party)',
  list: 'docNo leadName companyName mobile status nextContactOn ownerId',
  searchFields: ['docNo', 'leadName', 'companyName', 'email', 'mobile'],
  deletable: true,
  actions: [
    {
      key: 'toOpportunity',
      label: 'Make opportunity',
      primary: true,
      when: { status: ['NEW', 'CONTACTED', 'INTERESTED', 'REPLIED', 'QUALIFIED'] },
      fields: 'title! amountPaise:money expectedCloseOn:date',
      navigate: 'Opportunity',
      async run(session, lead, body, { actor }) {
        const opportunity = await createDoc(session, 'Opportunity', { title: body.title, leadId: String(lead._id), amountPaise: body.amountPaise ?? 0, expectedCloseOn: body.expectedCloseOn ?? null, ownerId: lead.ownerId ?? null }, actor);
        lead.status = 'QUALIFIED';
        await lead.save({ session });
        return opportunity;
      },
    },
    {
      key: 'toCustomer',
      label: 'Make customer',
      when: { status: ['NEW', 'CONTACTED', 'INTERESTED', 'REPLIED', 'QUALIFIED'] },
      fields: 'gstin stateCode',
      async run(session, lead, body) {
        const [party] = await Party.create([{
          code: await nextPartyCode(session, 'C'),
          name: lead.companyName || lead.leadName,
          isCustomer: true,
          email: lead.email,
          phone: lead.mobile || lead.phone,
          gstin: body.gstin ?? '',
          stateCode: body.stateCode ?? '',
          country: lead.country,
          contactName: lead.leadName,
        }], { session });
        lead.status = 'CONVERTED';
        lead.convertedPartyId = String(party._id);
        lead._labels = { ...(lead._labels ?? {}), convertedPartyId: `${party.code} · ${party.name}` };
        lead.markModified('_labels');
        await lead.save({ session });
        return lead;
      },
    },
  ],
});

define({
  name: 'Prospect',
  module: 'crm',
  fields: 'companyName!* industry marketSegmentId:link(MarketSegment) territoryId:link(Territory) annualRevenuePaise:money employees:int website ownerId:link(User) notes:long',
  tables: { leads: 'leadId:link(Lead)' },
  list: 'companyName industry territoryId ownerId',
  deletable: true,
});

define({
  name: 'Opportunity',
  module: 'crm',
  series: 'OP',
  dateField: 'expectedCloseOn',
  fields: 'title! leadId:link(Lead) partyId:link(Party;isCustomer=true) prospectId:link(Prospect) typeId:link(OpportunityType) stageId:link(SalesStage) status:select(OPEN,QUOTATION,WON,LOST,CLOSED)=OPEN amountPaise:money probabilityBps:pct expectedCloseOn:date ownerId:link(User) lostReasonId:link(OpportunityLostReason) competitorId:link(Competitor) notes:long',
  tables: { items: 'itemId:link(Item) qtyMilli:qty ratePaise:money' },
  list: 'docNo title partyId stageId amountPaise expectedCloseOn status',
  searchFields: ['docNo', 'title'],
  deletable: true,
  actions: [
    {
      key: 'markLost',
      label: 'Mark lost',
      when: { status: ['OPEN', 'QUOTATION'] },
      fields: 'lostReasonId!:link(OpportunityLostReason) competitorId:link(Competitor)',
      async run(session, doc, body) {
        if (!body.lostReasonId) throw rule('Say why it was lost.', 'REASON_REQUIRED');
        doc.status = 'LOST';
        doc.lostReasonId = body.lostReasonId;
        doc.competitorId = body.competitorId ?? null;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'markWon',
      label: 'Mark won',
      primary: true,
      when: { status: ['OPEN', 'QUOTATION'] },
      fields: '',
      async run(session, doc) {
        doc.status = 'WON';
        await doc.save({ session });
        const lead = doc.leadId ? await modelOf('Lead').findById(doc.leadId).session(session) : null;
        if (lead && lead.status !== 'CONVERTED') {
          lead.status = 'CONVERTED';
          await lead.save({ session });
        }
        return doc;
      },
    },
  ],
});

define({
  name: 'Campaign',
  module: 'crm',
  fields: 'name!* kind:select(EMAIL,EXHIBITION,REFERRAL,ADVERT,WEBINAR,OTHER)=EXHIBITION startDate:date endDate:date budgetPaise:money description:long isActive:check=true',
  dateField: 'startDate',
  list: 'name kind startDate endDate budgetPaise',
});
define({
  name: 'EmailCampaign',
  module: 'crm',
  fields: 'name!* campaignId!:link(Campaign) subject! body!:long recipients!:long sendOn:date status:select(SCHEDULED,SENT,CANCELLED)=SCHEDULED',
  list: 'name campaignId sendOn status',
});
define({
  name: 'Appointment',
  module: 'crm',
  fields: 'subject! onDate!:date atTime:time leadId:link(Lead) partyId:link(Party) ownerId:link(User) location status:select(OPEN,DONE,CANCELLED)=OPEN notes:long',
  dateField: 'onDate',
  list: 'subject onDate atTime leadId partyId status',
  deletable: true,
});
define({ name: 'ContractTemplate', module: 'crm', fields: 'name!* terms!:long requiresFulfilment:check', tables: { fulfilmentTerms: 'requirement!' }, list: 'name' });
define({
  name: 'Contract',
  module: 'crm',
  series: 'CT',
  submittable: true,
  fields: 'title! partyId!:link(Party) templateId:link(ContractTemplate) startDate!:date endDate:date valuePaise:money terms:long signedBy signedOn:date isFulfilled:check',
  tables: { fulfilment: 'requirement! isDone:check notes' },
  list: 'docNo title partyId startDate endDate valuePaise',
});
