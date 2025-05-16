import * as bson from './src';

const doc1 = bson.serialize({ foo: { bar: [{ num1: 1, num2: 2, numf: 0.4, verylongkeyname: 'abcdef' }] } });
const doc2 = bson.serialize({ foo: { bar: { num1: 1, numf2: 2.5, numf: 0.4, verylongkeyname: 'abcdef' } } });
let des;
for (let i = 0; i < 5000000; i++) {
  des = bson.deserialize(Math.random() < 0.5 ? doc1 : doc2);
}
console.dir(des, {depth: Infinity});
