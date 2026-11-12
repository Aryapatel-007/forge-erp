# How pharma machine builders work: research behind Forge's structure

November 2026. Public sources only: company and product pages, job postings, and GMP
qualification guidance. Companies rarely publish their org charts, so departments are
inferred from the jobs they advertise and the documents they deliver. Treat this as a
well-supported picture, not an inside view.

## The companies looked at

| Company | Where | What they build | What the sources show about how they work |
|---|---|---|---|
| NKP Pharma | Changodar and Vatva, Ahmedabad | Vial filling, dry powder filling, stoppering, sealing, complete lines | 30+ years, 201-500 people, exports. Departments not published. |
| ACG Engineering | Mumbai | Capsule fillers, tablet presses, coating, blister, cartoning | PO to FAT in 6 weeks on a rush order. Separate technical services team. A hardware and controls team supports "validation and QA". |
| Parle Global / Parle Tableting | Mumbai, Sanand (Ahmedabad) | Tablet presses, process equipment | Advertises machine sales engineers, application engineers who support FAT and SAT and write utility requirements, trainees writing FAT, IQ and OQ documents, purchase engineers who know GMP documents, design and service engineers. |
| Cadmach | Vatva, Ahmedabad (since 1967) | Tablet presses | Its own tooling facility for punches and dies (change parts). After-sales support and training. |
| Ambica Pharma Machines | Ahmedabad | Labelling, capping, powder and liquid filling | 40 years, standard machines built to order. |
| Harikrushna Machines | Ahmedabad | Liquid filling, capping, labelling, complete lines | Advertises a documentation engineer writing FAT, DQ, IQ, OQ and PQ documents. |
| Parth Engineers and Consultant | Vatva, Ahmedabad | Washing, liquid and powder filling, capping, labelling | Full lines from one maker, since 1996. |
| Uhlmann | Germany | Blister and cartoning lines | DQ and the FAT report are done at the factory; IQ, OQ and the SAT report on site. Qualification documents are customer-specific. |
| Syntegon | Germany | Capsule filling, liquid filling, packaging | Ran a fully virtual FAT, the customer watching live. |
| Bausch+Ströbel | Germany | Filling and closing for vials, syringes | Project managers guide each customer; a risk analysis for every machine. |
| Sartorius | Germany | Process equipment | One dedicated project manager per customer project. Test documents approved by the customer before handover. |

Engineer-to-order firms outside pharma (SIG, TGW, KSB, Fogg) show the same role: one
project manager owns an order from handover by sales until handover to after-sales or
the end of warranty.

## The departments they all have

1. **Sales and application.** Enquiries, the customer's User Requirement Specification
   (URS), technical and commercial offer, utility requirements, export enquiries.
2. **Projects.** One project manager per order: internal and customer kick-off, drawing
   approvals, the schedule, dispatch clearance, handover to service.
3. **Design.** Mechanical design, plus electrical and automation (PLC, HMI, 21 CFR Part 11).
4. **Documentation and validation.** DQ, FAT and SAT protocols, IQ and OQ documents,
   manuals, certificates (MOC of contact parts, surface finish, calibration).
5. **Purchase**, with GMP documents from suppliers.
6. **Stores and dispatch.** Receiving, issue, packing, invoice and transport papers.
7. **Production.** Machine shop, fabrication, assembly, electrical panel and wiring.
8. **Quality.** Incoming inspection, in-process checks, internal trial, FAT with the customer.
9. **Service.** Installation, commissioning, SAT, operator training, warranty, AMC, spares
   and change parts.
10. **Accounts.** Milestone billing: advance with the order, a payment before dispatch,
    the balance after installation.
11. **HR and administration.**
12. **Management.**

## One order, start to finish

1. Enquiry and URS received → technical offer and quotation.
2. Purchase order checked against the offer → order confirmed → advance received.
3. **Internal kick-off:** sales hands the order to projects; design, purchase, production
   and quality agree the plan.
4. **Customer kick-off:** schedule, contacts, documents to be supplied.
5. **GA drawing and DQ sent → approved by the customer.** Changes after this are change
   requests.
6. Design released (BOM, manufacturing drawings) → purchase orders, long-lead items first.
7. Materials received, inspected, issued.
8. Fabrication and machining → assembly and electrical → PLC/HMI programme.
9. **FAT protocol approved by the customer** → internal trial → **FAT witnessed by the
   customer** → punch points closed.
10. Payment before dispatch → **dispatch clearance** by the project manager → packed and
    dispatched with invoice and transport papers.
11. Installation and commissioning → **SAT and IQ/OQ** with the customer → training and
    handover of manuals, certificates and as-built drawings. Warranty starts.
12. Final payment. Service takes over: AMC, spares, change parts.

## What changed in Forge because of this

- Two new roles and departments: **Projects** (one person owns each order end to end)
  and **Documentation and validation** (DQ, FAT protocols, IQ/OQ, manuals).
- **Order journeys:** every machine order follows the 22 steps above
  (`server/config/orderJourney.js`). Each step belongs to a department. Steps that leave a
  record (payments, BOM release, purchase orders, issues, stages, FAT, dispatch,
  installation) tick themselves. Planned dates are spread so dispatch meets the delivery
  date.
- Each department's home page shows what is waiting on it across all orders.
- An **Orders board** shows every order's position in the seven phases at a glance.

## Sources

- NKP Pharma: [CPHI listing](https://www.cphi-online.com/company/nkp-pharma-pvt-ltd/), [Pharmaceutical-tech product page](https://www.pharmaceutical-tech.com/products/nkp-pharma-pvt-ltd/automatic-injectable-dry-powder-filling-with-rubber-stoppering-machine), [Expertia](https://www.expertia.ai/nkppharma)
- ACG: [Tablets & Capsules, PO to FAT in six weeks](https://www.e-digitaleditions.com/i/666166/53), [technical services](https://packagingconnections.com/pressrelease/acg-helps-prominent-us-pharma-customer-improve-yield-through-customized-dust), [hardware engineering job](https://careers.acg-world.com/job/Kandivali-Engineer-Hardware-Engineering%2C-A&C%2C-ACG-Engineering/54798544)
- Parle: [machine sales engineer](https://jobs.weekday.works/machine-sales-engineer-at-parle-tableting-technologies-pvt-ltd-4401589433), [graduate trainee, FAT/IQ/OQ documents](https://jobs.weekday.works/graduate-trainee-at-parle-tableting-technologies-pvt-ltd-4419583479), [service engineer](https://jobs.weekday.works/service-engineer-at-parle-global-technologies-pvt-ltd-4405130626), [purchasing engineer](https://jobs.weekday.works/purchasing-engineer-at-parle-tableting-technologies-pvt-ltd-4396522350)
- Cadmach: [supplier profile](https://www.pharmaceutical-tech.com/suppliers/cadmach-machinery-co-private-limited), [punches and dies](https://www.pharmaceutical-tech.com/products/cadmach-machinery-co-private-limited/punches-and-dies)
- Ambica: [CPHI listing](https://www.cphi-online.com/company/ambica-pharma-machines-pvt-ltd/)
- Harikrushna: [documentation engineer job](https://jobs.weekday.works/documentation-engineer-at-harikrushna-machines-pvt-ltd-wkdyakqlz6), [profile](https://www.pharmanow.live/pharma-companies/harikrushna-machines-pvt-ltd)
- Parth Engineers: [profile](https://www.pharmaceutical-tech.com/suppliers/parth-engineering-consultant)
- Uhlmann: [validation fact sheet](https://public.cms.uhlmann.de/dam/jcr:a92d66a4-dc37-4559-89d6-e7f506019f98/facts-validation-en.pdf)
- Syntegon: [virtual FAT](https://www.syntegon.com/news/virtual-fat/)
- Bausch+Ströbel: [project management](https://www.bausch-stroebel.com/en/bs-services/project)
- Sartorius: [project execution](https://www.sartorius.com/en/services/bioprocess-development-engineering/project-execution)
- Project manager role in engineer-to-order firms: [SIG](https://jobs.sig.biz/job/Project-Account-Manager-DE/53586-en_US/), [TGW](https://www.tgw-group.com/uk/career/jobs/detail/project-manager-distributor-business-unit)
- Order execution steps: [PO to delivery for process equipment](https://www.amergingtech.com/post/from-po-to-delivery-the-project-lifecycle-of-bioprocess-equipment), [project execution procedure](https://www.scribd.com/document/439936238/Project-01-Project-Execution-Process), [FAT in pharma](https://pharmamanufacturinghub.com/factory-acceptance-test-fat-in-pharmaceutical-industry-complete-gmp-guide-part-7/)
- Qualification: [EU GMP Annex 15](https://health.ec.europa.eu/document/download/7c6c5b3c-4902-46ea-b7ab-7608682fb68d_en), [Rommelag on FAT](https://www.rommelag.com/en/glossary/factory-acceptance-test)
