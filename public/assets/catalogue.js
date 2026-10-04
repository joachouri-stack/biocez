// Contenu éditorial des produits (textes, photos, composition).
// Les prix, noms et couleurs viennent de la base (/api/config) : ne pas les dupliquer ici.

export const CATALOGUE = {
  fer: {
    numero: 'N1',
    accent: '#ef7a4f', // couleur du produit lisible sur fond noir
    texteBouton: '#fff', // texte du bouton sur la couleur du produit
    badge: 'FER',
    image: '/assets/img/fer-pot-noir.webp',
    accroche: 'La formule anti coup de barre : cacao pur, moringa, baobab et chia, pour tenir la journée sans faiblir.',
    description: 'La formule anti coup de barre : cacao pur 100 %, moringa, baobab et chia. Une combinaison exclusive, sans additifs, pensée pour tenir la journée sans faiblir.',
    chiffre: { valeur: '14 mg', unite: 'de fer par portion' },
    bienfaits: ['Contribue à réduire la fatigue', 'Contribue à un métabolisme énergétique normal'],
    composition: [
      ['Cacao pur 100\u00a0%', 'Fer, Magnésium'],
      ['Baobab', 'Vitamine C'],
      ['Moringa', 'Vitamines A, B9, C'],
      ['Chia', 'Calcium, Oméga-3'],
    ],
    mention: 'Complément alimentaire. Source de fer : le fer contribue à réduire la fatigue. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
  vit: {
    numero: 'N2',
    accent: '#8cc76d', // couleur du produit lisible sur fond noir
    texteBouton: '#fff', // texte du bouton sur la couleur du produit
    badge: 'VITAMINES',
    image: '/assets/img/vit-pot-noir.webp',
    accroche: 'Banane, argousier, betterave et spiruline : un concentré de vitamine C, sans additifs, pour votre rituel du matin.',
    description: 'Un concentré de vitamines issu de quatre ingrédients bruts : banane, argousier, betterave et spiruline. Une formule exclusive, sans additifs, riche en vitamine C, qui contribue au fonctionnement normal du système immunitaire.',
    chiffre: { valeur: '60 mg', unite: 'de vitamine C par portion' },
    bienfaits: ['Contribue au fonctionnement normal du système immunitaire', 'Contribue à protéger les cellules contre le stress oxydatif'],
    composition: [
      ['Banane', 'Potassium, B6'],
      ['Argousier', 'Vitamines A, C, E'],
      ['Betterave', 'Potassium, A, Zinc'],
      ['Spiruline', 'Vitamines B1, B2, B3, B5, B6, B9, E, K'],
    ],
    mention: 'Complément alimentaire. Source de vitamine C : la vitamine C contribue au fonctionnement normal du système immunitaire. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
  pro: {
    numero: 'N3',
    accent: '#e0ae4f', // couleur du produit lisible sur fond noir
    texteBouton: '#241a05', // texte du bouton sur la couleur du produit
    badge: 'PROTÉINES',
    image: '/assets/img/pro-pot-noir.webp',
    accroche: 'Pois chiches, cacao pur, baobab et graines de courge : 35 g de protéines végétales pour 100 g, sans additifs.',
    description: 'Pois chiches, cacao pur, baobab et graines de courge : une formule exclusive, sans additifs, riche en protéines végétales, qui contribuent à augmenter et à maintenir la masse musculaire.',
    chiffre: { valeur: '35 g', unite: 'de protéines pour 100 g' },
    bienfaits: ['Contribue à augmenter la masse musculaire', 'Contribue au maintien de la masse musculaire'],
    composition: [
      ['Pois chiches', 'Protéines, B1, B6, B9'],
      ['Cacao pur 100\u00a0%', 'Fer, Magnésium'],
      ['Baobab', 'Vitamine C'],
      ['Graine de courge', 'Zinc, Magnésium'],
    ],
    mention: 'Complément alimentaire. Riche en protéines : les protéines contribuent à augmenter et à maintenir la masse musculaire. Ne pas dépasser la dose journalière recommandée. Tenir hors de portée des jeunes enfants. Ne se substitue pas à une alimentation variée et équilibrée.',
  },
};
