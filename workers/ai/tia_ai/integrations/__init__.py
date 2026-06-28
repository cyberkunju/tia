"""External ERP / accounting integration adapters.

Currently houses `sap_b1` (SAP Business One Service Layer OData v4 payload
generator). Each adapter is a pure mapping function - we never POST to a real
ERP from this layer; the demo surface generates the JSON, copies it, and
trusts the operator to push it.
"""
