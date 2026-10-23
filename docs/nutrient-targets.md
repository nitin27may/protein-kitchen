# Nutrient targets: adult aged 31-50, lacto-vegetarian, Indian-leaning

Source for all targets: Health Canada Dietary Reference Intakes tables (31-50 y). RDA = recommended, AI = adequate intake, UL = tolerable upper limit, ND = not determined. Profile: male, 40.5 y, 183 cm, 93 kg (BMI 27.8). No medical conditions or allergies reported. Female values were dropped. Not medical advice; the PLAN.md rule still holds (no supplement doses in app data).

## Targets

| Nutrient | Target (male) | UL | In micros.json? |
|---|---|---|---|
| Protein | 0.8 g/kg (74 g at 93 kg) | n/a | yes |
| Fibre | 38 g (AI) | ND | yes |
| Carbohydrate (digestible) | 130 g | n/a | yes |
| Linoleic acid (n-6) | 17 g (AI) | ND | yes |
| Alpha-linolenic acid (n-3) | 1.6 g (AI) | ND | yes |
| Calcium | 1000 mg | 2500 mg | yes |
| Iron | 8 mg | 45 mg | yes |
| Zinc | 11 mg | 40 mg | yes |
| Magnesium | 420 mg | 350 mg (supplements only) | yes |
| Potassium | 3400 mg (AI) | ND | yes |
| Sodium | 1500 mg (AI), 2300 mg chronic-disease level | ND | yes |
| Phosphorus | 700 mg | 4000 mg | yes |
| Selenium | 55 ug | 400 ug | yes |
| Copper | 900 ug | 10000 ug | yes |
| Manganese | 2.3 mg (AI) | 11 mg | yes |
| Iodine | 150 ug | 1100 ug | **no: CNF has no iodine** |
| Vitamin A | 900 ug RAE | 3000 ug | yes (RAE) |
| Vitamin C | 90 mg | 2000 mg | yes |
| Vitamin D | 15 ug (600 IU) | 100 ug | yes |
| Vitamin E | 15 mg | 1000 mg | yes |
| Vitamin K | 120 ug (AI) | ND | yes |
| Thiamin / Riboflavin | 1.2 / 1.3 mg | ND | yes |
| Vitamin B6 | 1.3 mg | 100 mg | yes |
| Folate | 400 ug DFE | 1000 ug (folic acid only) | yes |
| Vitamin B12 | 2.4 ug | ND | yes |
| Choline | 550 mg (AI) | 3500 mg | yes |
| Water | 3.7 L (AI, all sources) | n/a | n/a |

Not yet pulled: niacin, pantothenic acid, biotin, chromium, molybdenum, fluoride (targets known, CNF coverage unchecked).

## Vegetarian / Indian risk nutrients, ranked

| Nutrient | Why it is a risk | Best sources found in the CNF data (per 100 g) |
|---|---|---|
| Vitamin B12 | Only dairy supplies it. Dal, rice, roti, tofu and tempeh give essentially none | Whey powder 2.45 ug, cottage cheese 0.63, Greek yogurt 0.18. A 150 g serving of Greek yogurt gives about 0.3 ug of the 2.4 ug target, so reaching it from dairy alone takes a lot of dairy. Fortified foods or a supplement are worth discussing with a doctor |
| Vitamin D | Almost nothing in the library; Canadian winter sun is low | 0.0 in every ingredient pulled. Fortified milk and fortified plant milks are not in the data yet |
| Iodine | Depends on iodized salt and dairy | Not in CNF at all; needs another source or the iodized-salt assumption |
| Iron | Non-heme, with absorption lowered by phytates and tea. Dal, rajma, chole, pumpkin and hemp seeds are strong | Soy isolate 14.5 mg, hemp 11.2, pumpkin seeds 8.8, rajma 8.2, chia 7.7, masoor 7.4 |
| Zinc | Phytates in legumes and whole grains cut absorption | Watermelon seeds 10.2 mg, hemp 9.1, pumpkin seeds 7.8, sesame 6.7, cashews 5.8 |
| Omega-3 (ALA) | No fish; EPA and DHA are absent from the whole data set | Flax 22.8 g, chia 17.8, walnuts 9.1, hemp 8.6. The 1.1-1.6 g ALA target is met by 1 tbsp ground flax |
| Calcium | Fine with dairy; weak without it | Chia 631 mg, whey 469, tahini 420, almonds 269, tofu 201 (calcium-set) |
| Protein quality | Legumes are low in methionine, grains low in lysine | Combine dal or rajma with roti, rice or dairy across the day |

Folate, magnesium, potassium and fibre are not a concern on this diet. Dal, rajma, chole, seeds and wholegrains cover them easily.

## Supplements

The household is open to supplementing B12 and vitamin D if needed. The app plans food only and holds no supplement doses (PLAN.md rule). The only supplement-related output is the single Settings line: ask a doctor about a blood test for B12, vitamin D and ferritin. Dose and form come from the test result and the doctor, not from this repo.

## Open points

- Vegetarian adjustment for iron (commonly quoted as 1.8x the RDA) and for zinc (up to about 50% higher) comes from the 2001 IOM report. I could not confirm either figure from a source in this session, so they are not applied above. Verify them in the National Academies iron and zinc reports before adding them to the app.
- Phytate is not in CNF, so absorption cannot be computed from the data. Treat the iron and zinc totals as upper bounds.
- Sodium: CNF values are as sold, and recipe salt is not counted until recipes exist.
- Nutritional yeast (fortified B12), fortified milk, whole wheat atta and roasted chana had no usable CNF or USDA reference entry and are still unresolved.

## Gotchas

- CNF records zero for nutrients a food does not contain and omits others, so `micros.json` lists a `not_reported` array per ingredient. Do not read a missing value as zero when summing.
- Dry legumes are listed per 100 g dry weight. Multiply by `cooked_yield` to convert before comparing with cooked values.
