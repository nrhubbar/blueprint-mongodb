'use strict';

const blueprint = require ('@onehilltech/blueprint')
  , expect  = require ('chai').expect
  , async   = require ('async')
  , mongodb = require ('../../../../../lib')
  ;

describe ('listeners: app.start', function () {
  it ('should open all connections to the database', function (done) {
    async.every (mongodb.getConnectionManager ().connections, function (conn, callback) {
      var readyState = conn.readyState;
      return callback (null, readyState === 1 || readyState === 2);
    }, done);
  });

  it ('should seed the database with test data', function () {
    expect (blueprint.app).to.have.property ('seeds')
  });
});
