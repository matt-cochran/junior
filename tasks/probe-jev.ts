import { createPiClassifier, assessPreflight } from '../worker.ts';
const classify = await createPiClassifier();
const result = await assessPreflight({deliverable:'Add a status command reading saved result JSON',acceptance:['Valid results print their outcome','Missing files exit nonzero'],constraints:['No dependencies'],checks:[{command:'node',args:['--test','worker.test.ts']}]},classify);
console.log(JSON.stringify(result,null,2));
