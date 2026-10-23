# What "healthy" means in this app

The app prefers meals that are nutrient-dense, lighter and low in added sugar. This page says exactly how each label is calculated, what it is based on, and where it is the app's own definition.

## Low sugar

A serving is tagged **low sugar** when free sugars supply 5 percent of its energy or less.

- **Basis:** WHO recommends keeping free sugars under 10 percent of total energy, with a conditional further reduction to under 5 percent. WHO's definition covers sugars added by the manufacturer, cook or consumer, and sugars in honey, syrups and fruit juice. It does not cover sugars in whole fresh fruit, vegetables or milk. Secondary sources describing the 2015 guideline: [KSL summary](https://www.ksl.com/article/news/utah/science-and-tech/sugar-intake-should-be-halved-who-says/28958425), [FoodNavigator](https://www.foodnavigator.com/Legislation/WHO-recommends-halving-sugar-intake-advice). I did not read the WHO document itself, and I did not check for later updates.
- **What the app counts as free sugar:** white and brown sugar, honey, maple syrup, jaggery, molasses and sweetened condensed milk. It also counts dried dates and raisins, which is **stricter than WHO** because drying concentrates the sugar and the recipes use them to sweeten. Fresh fruit and plain milk or yogurt are not counted.
- **Total sugars** are shown separately. They include natural sugars from fruit, vegetables and milk.

## Light

A serving is tagged **light** when it is under a calorie ceiling for its meal: snack and shake 220 kcal, breakfast 400, lunch and dinner 450. These ceilings are this app's own, not medical thresholds. Protein per serving is still shown next to them, so light never hides a low-protein meal.

## Nutrient-dense

The nutrient score follows the structure of the Nutrient Rich Foods index (NRF9.3). The published index adds up the percent of a daily reference for nine nutrients to encourage (protein, fibre, vitamins A, C and E, calcium, iron, potassium, magnesium) and subtracts the percent of a maximum for three to limit (saturated fat, added sugar, sodium), per 100 kcal, with each encouraged nutrient capped at 100 percent. Source for the structure: [Drewnowski and Fulgoni, summarised by FAO AGRIS](https://agris.fao.org/search/ar/records/65de49dbb766d82b18fcee59).

This app's version differs on purpose:

| Part | Published NRF9.3 | This app |
|---|---|---|
| Encouraged | protein, fibre, A, C, E, calcium, iron, potassium, magnesium | protein, fibre, calcium, iron, potassium, magnesium, vitamin C, folate |
| Why different | | The Indian food tables do not report vitamins A and E, so folate replaces them |
| Limited | saturated fat, added sugar, sodium | saturated fat, free sugars, sodium |
| Reference values | published constants (not verified here) | protein 50 g, fibre 28 g, calcium 1300 mg, iron 18 mg, magnesium 420 mg, potassium 4700 mg, vitamin C 90 mg, folate 400 ug; limits: saturated fat 20 g, free sugars 50 g, sodium 2300 mg |

Free sugars 50 g is 10 percent of a 2,000 kcal day. Sodium 2,300 mg is Health Canada's chronic-disease reduction level. The other reference values are common daily values I used without checking them against a primary source, so treat the score as a ranking tool, not a measurement.

**Nutrient-dense** means the recipe is in the top third of the library by this score. It is relative on purpose, because there is no validated absolute cut-off for this score. Adding many very nutrient-dense recipes therefore moves the line.

## Gotchas

- Missing data lowers the penalties: some Indian-table ingredients (paneer, ragi, jaggery) have no saturated fat, sugar or sodium values. The recipe page shows an asterisk when that happens, and the amounts are then a minimum.
- The score rewards low-calorie, vegetable-heavy dishes. A calorie-dense but valuable meal (nuts, paneer) scores lower even when it is a good protein source. That is why protein is always shown separately.
- The planner treats all three as gentle preferences. Protein targets and your liked foods still decide most choices.
