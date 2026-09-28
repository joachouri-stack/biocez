// Contenu éditorial des produits (textes, photos, composition).
// Les prix, noms et couleurs viennent de la base (/api/config) : ne pas les dupliquer ici.

export const CATALOGUE = {
  fer: {
    badge: 'FER',
    image: '/assets/img/fer.jpg',
    imageDetail: '/assets/img/fer-detail.jpg',
    accroche: 'La formule anti coup de barre : cacao pur, moringa, baobab et chia, pour tenir la journée sans faiblir.',
    description: 'La formule anti coup de barre : cacao pur 100 %, moringa, baobab et chia. Une combinaison exclusive, sans additifs, pensée pour tenir la journée sans faiblir.',
    chiffre: { valeur: '14 mg', unite: 'de fer par portion' },
    bienfaits: ['Réduit la fatigue', 'Soutient l’énergie au quotidien'],
    composition: [
      ['Cacao pur 100 %', 'Fer, Magnésium'],
      ['Baobab', 'Vitamine C'],
      ['Moringa', 'Vitamines A, B9, C'],
      ['Chia', 'Calcium, Oméga-3'],
    ],
    mention: 'Complément alimentaire. Source de fer : le fer contribue à réduire la fatigue. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
  vit: {
    badge: 'VITAMINES',
    image: '/assets/img/vit.jpg',
    accroche: 'Un concentré de vitamine C et d’antioxydants pour soutenir vos défenses naturelles au quotidien.',
    description: 'Un concentré de vitamines issu de quatre ingrédients bruts : banane, argousier, betterave et spiruline. Une formule exclusive, sans additifs, pour soutenir vos défenses naturelles et votre vitalité au quotidien.',
    chiffre: { valeur: '60 mg', unite: 'de vitamine C par portion' },
    bienfaits: ['Soutient l’immunité', 'Contribue à la vitalité'],
    composition: [
      ['Banane', 'Potassium, B6'],
      ['Argousier', 'Vitamines A, C, E'],
      ['Betterave', 'Potassium, A, Zinc'],
      ['Spiruline', 'Vitamines B1, B2, B3, B5, B6, B9, E, K'],
    ],
    mention: 'Complément alimentaire. Source de vitamine C : la vitamine C contribue au fonctionnement normal du système immunitaire. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
  pro: {
    badge: 'PROTÉINES',
    image: '/assets/img/pro.jpg',
    accroche: 'Pois chiches et graines de courge pour nourrir le muscle et soutenir la récupération après l’effort.',
    description: 'Pois chiches, cacao pur, baobab et graines de courge : une source de protéines végétales, sans additifs, pour nourrir le muscle et soutenir la récupération après l’effort.',
    chiffre: { valeur: '35 g', unite: 'de protéines pour 100 g' },
    bienfaits: ['Contribue au développement musculaire', 'Soutient la récupération'],
    composition: [
      ['Pois chiches', 'Protéines, B1, B6, B9'],
      ['Cacao pur 100 %', 'Fer, Magnésium'],
      ['Baobab', 'Vitamine C'],
      ['Graine de courge', 'Zinc, Magnésium'],
    ],
    mention: 'Complément alimentaire. Riche en protéines : les protéines contribuent à augmenter et à maintenir la masse musculaire. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
};
